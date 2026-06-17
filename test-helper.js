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
  return data && typeof data === "object" && typeof data.schemaVersion === "number" && data.entities;
}

function flattenData(data) {
  if (isV2Structure(data)) {
    return data.entities;
  }
  return data;
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

function writeDb(data) {
  ensureDataDir();
  const toWrite = isV2Structure(data) ? data : wrapInV2(data);
  if (isV2Structure(toWrite)) {
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
  flattenData,
  wrapInV2,
  readDb,
  writeDb,
  backupDb,
  restoreDb
};
