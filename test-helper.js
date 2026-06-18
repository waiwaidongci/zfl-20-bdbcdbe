const fs = require("fs");
const path = require("path");
const net = require("net");
const http = require("http");
const { spawn } = require("child_process");
const migrator = require("./data-migrator");

const DB_FILE = path.join(__dirname, "data", "db.json");
const AUDIT_LOG_FILE = path.join(__dirname, "data", "audit-logs.json");

function ensureDataDir() {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isV2Structure(data) {
  return data && typeof data === "object" && typeof data.schemaVersion === "number" && data.schemaVersion === 2 && data.entities;
}

function isV3Structure(data) {
  return data && typeof data === "object" && typeof data.schemaVersion === "number" && data.schemaVersion >= 3 && data.entities && Array.isArray(data.auditTrail);
}

function isVersionedStructure(data) {
  return isV2Structure(data) || isV3Structure(data);
}

function flattenData(data) {
  if (isVersionedStructure(data)) {
    const result = { ...data.entities };
    if (data.auditTrail) {
      result.auditTrail = data.auditTrail;
    }
    return result;
  }
  return data;
}

function detectDbVersion(data) {
  if (isV3Structure(data)) return 3;
  if (isV2Structure(data)) return 2;
  if (data && typeof data === "object" && typeof data.schemaVersion === "number") return data.schemaVersion;
  return 0;
}

function wrapInV2(data) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    meta: {
      createdAt: now,
      lastModifiedAt: now,
      migrationHistory: [],
      dataStatistics: {
        rubbings: (data.rubbings || []).length,
        damages: (data.damages || []).length,
        batches: (data.batches || []).length,
        repairImages: (data.repairImages || []).length,
        batchSnapshots: (data.batchSnapshots || []).length
      }
    },
    entities: {
      rubbings: data.rubbings || [],
      damages: data.damages || [],
      batches: data.batches || [],
      repairImages: data.repairImages || [],
      batchSnapshots: data.batchSnapshots || []
    },
    imageArchive: {
      archivedImages: [],
      archiveStats: {
        totalArchived: 0,
        lastArchivedAt: null,
        storagePath: "./data/image-archive"
      }
    }
  };
}

function wrapInV3(data) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 3,
    meta: {
      createdAt: now,
      lastModifiedAt: now,
      migrationHistory: [],
      dataStatistics: {
        rubbings: (data.rubbings || []).length,
        damages: (data.damages || []).length,
        batches: (data.batches || []).length,
        repairImages: (data.repairImages || []).length,
        batchSnapshots: (data.batchSnapshots || []).length,
        auditTrailEvents: (data.auditTrail || []).length
      }
    },
    entities: {
      rubbings: data.rubbings || [],
      damages: data.damages || [],
      batches: data.batches || [],
      repairImages: data.repairImages || [],
      batchSnapshots: data.batchSnapshots || []
    },
    imageArchive: {
      summary: migrator.rebuildImageArchiveStats({
        rubbings: data.rubbings || [],
        damages: data.damages || [],
        batches: data.batches || [],
        repairImages: data.repairImages || [],
        batchSnapshots: data.batchSnapshots || []
      })
    },
    auditTrail: data.auditTrail || []
  };
}

function readDb() {
  if (!fs.existsSync(DB_FILE)) {
    return null;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (parseErr) {
    console.error(`[test-helper readDb] JSON 解析失败: ${parseErr.message}`);
    return { rubbings: [], damages: [], batches: [], repairImages: [], batchSnapshots: [] };
  }
  return flattenData(raw);
}

function getDefaultWriteVersion() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
      return detectDbVersion(raw);
    } catch (e) {
      return migrator.CURRENT_SCHEMA_VERSION;
    }
  }
  return migrator.CURRENT_SCHEMA_VERSION;
}

function writeDb(data, options = {}) {
  ensureDataDir();

  let toWrite;
  if (options.raw) {
    toWrite = data;
  } else if (isVersionedStructure(data)) {
    toWrite = data;
  } else {
    const targetVersion = options.targetVersion || getDefaultWriteVersion();
    if (targetVersion >= 3) {
      toWrite = wrapInV3(data);
    } else {
      toWrite = wrapInV2(data);
    }
  }

  const version = detectDbVersion(toWrite);
  if (version >= 3) {
    toWrite.meta.dataStatistics = {
      rubbings: toWrite.entities.rubbings.length,
      damages: toWrite.entities.damages.length,
      batches: toWrite.entities.batches.length,
      repairImages: toWrite.entities.repairImages.length,
      batchSnapshots: toWrite.entities.batchSnapshots.length,
      auditTrailEvents: (toWrite.auditTrail || []).length
    };
    toWrite.imageArchive.summary = migrator.rebuildImageArchiveStats(toWrite.entities);
    const v3Errors = migrator.validateV3Structure(toWrite);
    if (v3Errors.length > 0) {
      throw new Error(`写入被阻断：v3 结构校验失败 - ${v3Errors.join("; ")}`);
    }
  } else if (version === 2) {
    const v2Errors = migrator.validateV2Structure(toWrite);
    if (v2Errors.length > 0) {
      throw new Error(`写入被阻断：v2 结构校验失败 - ${v2Errors.join("; ")}`);
    }
  }

  const tempFile = path.join(path.dirname(DB_FILE), `.db_test_${Date.now()}.json`);
  try {
    fs.writeFileSync(tempFile, JSON.stringify(toWrite, null, 2));
    JSON.parse(fs.readFileSync(tempFile, "utf8"));
    try {
      fs.renameSync(tempFile, DB_FILE);
    } catch (renameErr) {
      if (renameErr.code === "EXDEV" || renameErr.code === "EPERM") {
        fs.copyFileSync(tempFile, DB_FILE);
        fs.unlinkSync(tempFile);
      } else {
        throw renameErr;
      }
    }
  } catch (e) {
    try {
      fs.unlinkSync(tempFile);
    } catch (_) {
    }
    throw e;
  }
}

function backupDb(backupFile) {
  if (fs.existsSync(DB_FILE)) {
    fs.copyFileSync(DB_FILE, backupFile);
  }
}

function restoreDb(backupFile) {
  if (fs.existsSync(backupFile)) {
    const tempFile = path.join(path.dirname(DB_FILE), `.db_restore_${Date.now()}.json`);
    try {
      fs.copyFileSync(backupFile, tempFile);
      fs.renameSync(tempFile, DB_FILE);
    } finally {
      try {
        fs.unlinkSync(tempFile);
      } catch (_) {
      }
    }
    try {
      fs.unlinkSync(backupFile);
    } catch (_) {
    }
  }
}

function backupAuditLog(backupFile) {
  if (fs.existsSync(AUDIT_LOG_FILE)) {
    fs.copyFileSync(AUDIT_LOG_FILE, backupFile);
  }
}

function restoreAuditLog(backupFile) {
  if (fs.existsSync(backupFile)) {
    fs.copyFileSync(backupFile, AUDIT_LOG_FILE);
    try {
      fs.unlinkSync(backupFile);
    } catch (_) {}
  }
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

function createTestServer(configuredPort = null) {
  let server;
  let baseUrl;

  const start = () => new Promise(async (resolve, reject) => {
    const port = configuredPort || await findAvailablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn("node", ["server.js"], {
      cwd: __dirname,
      env: { ...process.env, PORT: String(port) }
    });

    server.stderr.on("data", (data) => {
      process.stderr.write(`[server stderr] ${data}`);
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        reject(new Error("Server startup timeout"));
      }
    }, 5000);

    server.stdout.on("data", (data) => {
      const msg = data.toString();
      if (msg.includes("Rubbing repair API running") && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        setTimeout(resolve, 200);
      }
    });

    server.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
  });

  const stop = () => new Promise((resolve) => {
    if (server) {
      server.kill("SIGTERM");
      server.on("close", resolve);
      setTimeout(resolve, 1000);
    } else {
      resolve();
    }
  });

  const request = (method, pathname, body, expectText = false) => new Promise((resolve, reject) => {
    const url = `${baseUrl}${pathname}`;
    const options = {
      method,
      headers: { "Content-Type": "application/json" }
    };
    const req = http.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (expectText) {
          resolve({ status: res.statusCode, body: data, headers: res.headers });
        } else {
          let parsed = data;
          try {
            parsed = JSON.parse(data);
          } catch (_) {}
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        }
      });
    });
    req.on("error", reject);
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });

  const getBaseUrl = () => baseUrl;

  return { start, stop, request, getBaseUrl };
}

function createAssert() {
  let passed = 0;
  let failed = 0;

  const assert = (condition, message) => {
    if (condition) {
      passed += 1;
      console.log(`  ✅ ${message}`);
    } else {
      failed += 1;
      console.log(`  ❌ ${message}`);
    }
  };

  const assertEqual = (actual, expected, message) => {
    if (actual === expected) {
      passed += 1;
      console.log(`  ✅ ${message}`);
    } else {
      failed += 1;
      console.log(`  ❌ ${message} (expected: ${JSON.stringify(expected)}, actual: ${JSON.stringify(actual)})`);
    }
  };

  const assertNotNull = (value, message) => {
    if (value !== null && value !== undefined) {
      passed += 1;
      console.log(`  ✅ ${message}`);
    } else {
      failed += 1;
      console.log(`  ❌ ${message} (value is null/undefined)`);
    }
  };

  const assertContains = (str, substr, message) => {
    if (str && String(str).includes(substr)) {
      passed += 1;
      console.log(`  ✅ ${message}`);
    } else {
      failed += 1;
      console.log(`  ❌ ${message}`);
      console.log(`    期望包含: ${substr}`);
      console.log(`    实际: ${str}`);
    }
  };

  const getStats = () => ({ passed, failed });
  const resetStats = () => { passed = 0; failed = 0; };

  return { assert, assertEqual, assertNotNull, assertContains, getStats, resetStats };
}

module.exports = {
  DB_FILE,
  AUDIT_LOG_FILE,
  isV2Structure,
  isV3Structure,
  isVersionedStructure,
  flattenData,
  wrapInV2,
  wrapInV3,
  detectDbVersion,
  getDefaultWriteVersion,
  readDb,
  writeDb,
  backupDb,
  restoreDb,
  backupAuditLog,
  restoreAuditLog,
  findAvailablePort,
  createTestServer,
  createAssert
};
