const fs = require("fs");
const path = require("path");
const migrator = require("./data-migrator");

const DB_FILE = path.join(__dirname, "data", "db.json");

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

module.exports = {
  DB_FILE,
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
  restoreDb
};
