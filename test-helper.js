const fs = require("fs");
const path = require("path");

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
  const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  return flattenData(raw);
}

function writeDb(data) {
  ensureDataDir();
  const toWrite = isV2Structure(data) ? data : wrapInV2(data);
  const tempFile = path.join(path.dirname(DB_FILE), `.db_test_${Date.now()}.json`);
  try {
    fs.writeFileSync(tempFile, JSON.stringify(toWrite, null, 2));
    fs.renameSync(tempFile, DB_FILE);
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
