const { readFile, writeFile, mkdir, readdir, stat, unlink, rename, copyFile } = require("fs/promises");
const path = require("path");

const BACKUP_ERRORS = {
  BACKUP_NOT_FOUND: "BACKUP_NOT_FOUND",
  JSON_CORRUPTED: "JSON_CORRUPTED",
  INVALID_STRUCTURE: "INVALID_STRUCTURE",
  UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
  EMPTY_BACKUP: "EMPTY_BACKUP"
};

const DIFF_SAMPLE_LIMIT = 5;
const BACKUP_FILENAME_PATTERN = /^(backup_|migration_backup_)\d{8}_\d{6,9}[_a-z0-9]*\.json$/;
const ENTITY_KEY_FIELDS = {
  rubbings: ["id", "code", "source", "paperSize"],
  damages: ["id", "position", "type", "status", "reviewStatus"],
  batches: ["id", "name", "status"],
  repairImages: ["id", "damageId", "stage", "url"],
  batchSnapshots: ["id", "batchId", "createdAt"],
  auditTrail: ["id", "eventType", "targetType", "targetId", "timestamp"]
};

function createBackupManager({ backupDir, dbFile, readDb, enqueueWrite, getWriteVersion, createVersionConflictError, migrator }) {
  async function ensureBackupDir() {
    await mkdir(backupDir, { recursive: true });
  }

  function formatBackupTimestamp(date) {
    const pad = (n, len = 2) => String(n).padStart(len, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`;
  }

  function getBackupFilename(timestamp) {
    const suffix = Math.random().toString(36).slice(2, 8);
    return `backup_${timestamp}_${suffix}.json`;
  }

  function validateDataStructure(data) {
    if (!data || typeof data !== "object") return false;
    if (typeof data.schemaVersion === "number" && data.entities) {
      const v2RequiredKeys = ["rubbings", "damages", "batches"];
      const v2OptionalKeys = ["repairImages", "batchSnapshots"];
      for (const key of v2RequiredKeys) {
        if (!Array.isArray(data.entities[key])) return false;
      }
      for (const key of v2OptionalKeys) {
        if (data.entities[key] !== undefined && !Array.isArray(data.entities[key])) return false;
      }
      if (data.schemaVersion >= 3 && !Array.isArray(data.auditTrail)) return false;
      return true;
    }
    const v0RequiredKeys = ["rubbings", "damages", "batches"];
    const v0OptionalKeys = ["repairImages", "batchSnapshots", "auditTrail"];
    for (const key of v0RequiredKeys) {
      if (!Array.isArray(data[key])) return false;
    }
    for (const key of v0OptionalKeys) {
      if (data[key] !== undefined && !Array.isArray(data[key])) return false;
    }
    return true;
  }

  function getDataCounts(data) {
    if (data && typeof data === "object" && typeof data.schemaVersion === "number" && data.entities) {
      const counts = {
        rubbings: (data.entities.rubbings || []).length,
        damages: (data.entities.damages || []).length,
        batches: (data.entities.batches || []).length,
        repairImages: (data.entities.repairImages || []).length,
        batchSnapshots: (data.entities.batchSnapshots || []).length
      };
      if (data.schemaVersion >= 3) {
        counts.auditTrailEvents = (data.auditTrail || []).length;
      }
      return counts;
    }
    return {
      rubbings: (data?.rubbings || []).length,
      damages: (data?.damages || []).length,
      batches: (data?.batches || []).length,
      repairImages: (data?.repairImages || []).length,
      batchSnapshots: (data?.batchSnapshots || []).length
    };
  }

  function sanitizeBackupFilename(filename) {
    if (!filename || typeof filename !== "string") {
      const error = new Error("备份文件名无效");
      error.code = BACKUP_ERRORS.BACKUP_NOT_FOUND;
      error.status = 400;
      throw error;
    }
    if (!BACKUP_FILENAME_PATTERN.test(filename)) {
      const error = new Error("备份文件名格式无效，只允许字母数字和下划线");
      error.code = BACKUP_ERRORS.BACKUP_NOT_FOUND;
      error.status = 400;
      throw error;
    }
    const resolved = path.resolve(backupDir, filename);
    if (!resolved.startsWith(path.resolve(backupDir) + path.sep) && resolved !== path.resolve(backupDir)) {
      const error = new Error("备份文件路径越界");
      error.code = BACKUP_ERRORS.BACKUP_NOT_FOUND;
      error.status = 400;
      throw error;
    }
    return filename;
  }

  async function createBackup() {
    await ensureBackupDir();
    const dbContent = await readFile(dbFile, "utf8");
    let parsedData;
    try {
      parsedData = JSON.parse(dbContent);
    } catch {
      const error = new Error("当前数据库JSON损坏，无法创建备份");
      error.code = BACKUP_ERRORS.JSON_CORRUPTED;
      error.status = 500;
      throw error;
    }
    if (!validateDataStructure(parsedData)) {
      const error = new Error("当前数据库结构不符合预期，无法创建备份");
      error.code = BACKUP_ERRORS.INVALID_STRUCTURE;
      error.status = 500;
      throw error;
    }
    const timestamp = formatBackupTimestamp(new Date());
    const filename = getBackupFilename(timestamp);
    const backupPath = path.join(backupDir, filename);
    const counts = getDataCounts(parsedData);
    const backupData = {
      meta: {
        createdAt: new Date().toISOString(),
        version: parsedData.schemaVersion || 0,
        dataCounts: counts
      },
      data: parsedData
    };
    await writeFile(backupPath, JSON.stringify(backupData, null, 2));
    const stats = await stat(backupPath);
    return {
      filename,
      createdAt: backupData.meta.createdAt,
      size: stats.size,
      dataCounts: backupData.meta.dataCounts
    };
  }

  async function listBackups() {
    await ensureBackupDir();
    const files = await readdir(backupDir);
    const backupFiles = files.filter((f) => BACKUP_FILENAME_PATTERN.test(f));
    const backups = [];
    for (const filename of backupFiles) {
      try {
        const backupPath = path.join(backupDir, filename);
        const stats = await stat(backupPath);
        const content = JSON.parse(await readFile(backupPath, "utf8"));
        backups.push({
          filename,
          createdAt: content.meta?.createdAt || stats.mtime.toISOString(),
          size: stats.size,
          dataCounts: content.meta?.dataCounts || null
        });
      } catch {
        continue;
      }
    }
    backups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return backups;
  }

  async function readBackupFile(filename) {
    sanitizeBackupFilename(filename);
    await ensureBackupDir();
    const backupPath = path.join(backupDir, filename);
    let content;
    try {
      content = await readFile(backupPath, "utf8");
    } catch {
      const error = new Error(`备份文件不存在: ${filename}`);
      error.code = BACKUP_ERRORS.BACKUP_NOT_FOUND;
      error.status = 404;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      const error = new Error("备份文件JSON损坏");
      error.code = BACKUP_ERRORS.JSON_CORRUPTED;
      error.status = 400;
      throw error;
    }
    return parsed;
  }

  async function validateBackup(filename) {
    const backup = await readBackupFile(filename);
    if (!backup.data || !validateDataStructure(backup.data)) {
      const error = new Error("备份数据结构不符合项目预期");
      error.code = BACKUP_ERRORS.INVALID_STRUCTURE;
      error.status = 400;
      throw error;
    }
    const stats = await stat(path.join(backupDir, filename));
    return {
      filename,
      valid: true,
      createdAt: backup.meta?.createdAt || stats.mtime.toISOString(),
      dataCounts: backup.meta?.dataCounts || getDataCounts(backup.data),
      size: stats.size
    };
  }

  function pickKeyFields(entity, entityType) {
    const keys = ENTITY_KEY_FIELDS[entityType] || ["id"];
    const result = {};
    keys.forEach((k) => {
      if (entity[k] !== undefined) result[k] = entity[k];
    });
    return result;
  }

  function computeFieldChanges(oldEntity, newEntity, entityType) {
    const keys = ENTITY_KEY_FIELDS[entityType] || Object.keys(newEntity || {});
    const changes = [];
    keys.forEach((k) => {
      const oldVal = oldEntity?.[k];
      const newVal = newEntity?.[k];
      if (oldVal !== newVal) {
        changes.push({
          field: k,
          oldValue: oldVal ?? null,
          newValue: newVal ?? null
        });
      }
    });
    return changes;
  }

  function computeEntityDiff(currentEntities, backupEntities, entityType) {
    const currentMap = new Map((currentEntities || []).map((e) => [e.id, e]));
    const backupMap = new Map((backupEntities || []).map((e) => [e.id, e]));

    const added = [];
    const removed = [];
    const changed = [];

    backupMap.forEach((entity, id) => {
      if (!currentMap.has(id)) {
        added.push({ id, ...pickKeyFields(entity, entityType) });
      } else {
        const currentEntity = currentMap.get(id);
        const fieldChanges = computeFieldChanges(currentEntity, entity, entityType);
        if (fieldChanges.length > 0) {
          changed.push({
            id,
            ...pickKeyFields(entity, entityType),
            fieldChanges
          });
        }
      }
    });

    currentMap.forEach((entity, id) => {
      if (!backupMap.has(id)) {
        removed.push({ id, ...pickKeyFields(entity, entityType) });
      }
    });

    return {
      counts: {
        added: added.length,
        removed: removed.length,
        changed: changed.length,
        totalInBackup: backupMap.size,
        totalInCurrent: currentMap.size
      },
      samples: {
        added: added.slice(0, DIFF_SAMPLE_LIMIT),
        removed: removed.slice(0, DIFF_SAMPLE_LIMIT),
        changed: changed.slice(0, DIFF_SAMPLE_LIMIT)
      },
      hasMore: {
        added: added.length > DIFF_SAMPLE_LIMIT,
        removed: removed.length > DIFF_SAMPLE_LIMIT,
        changed: changed.length > DIFF_SAMPLE_LIMIT
      }
    };
  }

  function readBackupEntities(backupData) {
    if (!backupData || typeof backupData !== "object") {
      return null;
    }
    if (typeof backupData.schemaVersion === "number" && backupData.entities) {
      const result = {
        rubbings: backupData.entities.rubbings || [],
        damages: backupData.entities.damages || [],
        batches: backupData.entities.batches || [],
        repairImages: backupData.entities.repairImages || [],
        batchSnapshots: backupData.entities.batchSnapshots || []
      };
      if (backupData.schemaVersion >= 3) {
        result.auditTrail = backupData.auditTrail || [];
      }
      return result;
    }
    return {
      rubbings: backupData.rubbings || [],
      damages: backupData.damages || [],
      batches: backupData.batches || [],
      repairImages: backupData.repairImages || [],
      batchSnapshots: backupData.batchSnapshots || [],
      auditTrail: backupData.auditTrail || []
    };
  }

  function detectBackupStructure(backup) {
    if (!backup || !backup.data || typeof backup.data !== "object") {
      return { version: null, structure: "invalid", readable: false };
    }
    const data = backup.data;
    if (typeof data.schemaVersion === "number") {
      if (data.schemaVersion === 3 && data.entities && Array.isArray(data.auditTrail)) {
        return { version: 3, structure: "v3", readable: true };
      }
      if (data.schemaVersion === 2 && data.entities) {
        return { version: 2, structure: "v2", readable: true };
      }
      if (data.schemaVersion === 1) {
        return { version: 1, structure: "v1", readable: true };
      }
      return { version: data.schemaVersion, structure: "unknown_version", readable: false };
    }
    const legacyKeys = ["rubbings", "damages", "batches"];
    const hasLegacy = legacyKeys.every((k) => Array.isArray(data[k]));
    if (hasLegacy) {
      return { version: 0, structure: "v0_flat", readable: true };
    }
    return { version: null, structure: "unrecognized", readable: false };
  }

  async function computeBackupDiff(filename) {
    const result = {
      filename,
      backupMeta: null,
      backupStructure: null,
      currentCounts: null,
      backupCounts: null,
      diff: null,
      summary: null,
      warnings: []
    };

    let backup;
    try {
      backup = await readBackupFile(filename);
    } catch (readError) {
      if (readError.code === BACKUP_ERRORS.JSON_CORRUPTED) {
        return {
          ...result,
          backupStructure: { version: null, structure: "json_corrupted", readable: false },
          warnings: [`备份文件JSON损坏，无法解析: ${readError.message}`],
          error: {
            code: BACKUP_ERRORS.JSON_CORRUPTED,
            message: "备份文件JSON损坏，无法读取差异"
          }
        };
      }
      throw readError;
    }

    result.backupMeta = {
      createdAt: backup.meta?.createdAt || null,
      version: backup.meta?.version ?? null,
      type: backup.meta?.type || "normal_backup"
    };

    const structureInfo = detectBackupStructure(backup);
    result.backupStructure = structureInfo;

    if (!structureInfo.readable) {
      result.warnings.push(`备份数据结构无法识别（${structureInfo.structure}），无法计算差异`);
      result.error = {
        code: BACKUP_ERRORS.INVALID_STRUCTURE,
        message: `备份结构无效或不受支持: ${structureInfo.structure}`
      };
      return result;
    }

    if (structureInfo.version === 0) {
      result.warnings.push("检测到 v0 旧结构备份，数据字段可能不完整（缺少 repairImages/batchSnapshots）");
    }

    const currentDb = await readDb();
    const backupEntities = readBackupEntities(backup.data);

    result.currentCounts = getDataCounts(currentDb);
    result.backupCounts = getDataCounts(backup.data);

    const entityTypes = ["rubbings", "damages", "batches", "repairImages", "batchSnapshots"];
    result.diff = {};

    entityTypes.forEach((type) => {
      result.diff[type] = computeEntityDiff(currentDb[type], backupEntities[type], type);
    });

    if (structureInfo.version >= 3 && currentDb.auditTrail) {
      result.diff.auditTrail = computeEntityDiff(currentDb.auditTrail, backupEntities.auditTrail || [], "auditTrail");
    }

    const totalAdded = entityTypes.reduce((sum, t) => sum + result.diff[t].counts.added, 0)
      + (result.diff.auditTrail ? result.diff.auditTrail.counts.added : 0);
    const totalRemoved = entityTypes.reduce((sum, t) => sum + result.diff[t].counts.removed, 0)
      + (result.diff.auditTrail ? result.diff.auditTrail.counts.removed : 0);
    const totalChanged = entityTypes.reduce((sum, t) => sum + result.diff[t].counts.changed, 0)
      + (result.diff.auditTrail ? result.diff.auditTrail.counts.changed : 0);

    result.summary = {
      totalAdded,
      totalRemoved,
      totalChanged,
      totalImpacted: totalAdded + totalRemoved + totalChanged,
      restoreImpact: `恢复将新增 ${totalAdded} 条、删除 ${totalRemoved} 条、变更 ${totalChanged} 条记录（共 ${totalAdded + totalRemoved + totalChanged} 条受影响）`
    };

    return result;
  }

  async function restoreFromBackup(filename, precomputedDiff = null, expectedVersion = undefined) {
    const validation = await validateBackup(filename);
    const backup = await readBackupFile(filename);
    const tempFile = path.join(backupDir, `temp_restore_${Date.now()}.json`);

    let diff = precomputedDiff;
    if (!diff) {
      try {
        diff = await computeBackupDiff(filename);
      } catch (diffError) {
        diff = {
          error: {
            code: diffError.code || "DIFF_COMPUTE_FAILED",
            message: diffError.message || "差异计算失败"
          },
          warnings: [`差异计算失败: ${diffError.message}`]
        };
      }
    }

    const warnings = [...(diff.warnings || [])];
    let migrationResult = null;

    try {
      await writeFile(tempFile, JSON.stringify(backup.data, null, 2));
      const verifyData = JSON.parse(await readFile(tempFile, "utf8"));
      if (!validateDataStructure(verifyData)) {
        throw new Error("恢复前校验失败：数据结构无效");
      }

      migrationResult = await enqueueWrite(async () => {
        let currentRaw;
        try {
          currentRaw = JSON.parse(await readFile(dbFile, "utf8"));
        } catch (_) {
          currentRaw = null;
        }
        const currentVersion = getWriteVersion(currentRaw);

        if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
          throw createVersionConflictError(expectedVersion, currentVersion);
        }

        let dataToWrite = JSON.parse(JSON.stringify(backup.data));

        if (dataToWrite && typeof dataToWrite === "object" && dataToWrite.meta) {
          dataToWrite.meta.writeVersion = currentVersion + 1;
          dataToWrite.meta.lastModifiedAt = new Date().toISOString();
        } else if (dataToWrite && typeof dataToWrite === "object") {
          dataToWrite.meta = { writeVersion: currentVersion + 1, lastModifiedAt: new Date().toISOString() };
        }

        const dbTempFile = path.join(path.dirname(dbFile), `.db.tmp.restore.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.json`);
        try {
          await writeFile(dbTempFile, JSON.stringify(dataToWrite, null, 2));
          JSON.parse(await readFile(dbTempFile, "utf8"));
          try {
            await rename(dbTempFile, dbFile);
          } catch (renameErr) {
            if (renameErr.code === "EXDEV" || renameErr.code === "EPERM") {
              await copyFile(dbTempFile, dbFile);
              await unlink(dbTempFile);
            } else {
              throw renameErr;
            }
          }
        } catch (e) {
          try {
            await unlink(dbTempFile);
          } catch (_) {
          }
          throw e;
        }

        const backupVersion = backup.data.schemaVersion ?? 0;
        if (backupVersion < migrator.CURRENT_SCHEMA_VERSION) {
          return migrator.migrateToLatest(currentVersion + 1);
        }
        return null;
      });

      if (migrationResult && migrationResult.action === "migrated") {
        warnings.push(`自动升级成功: v${migrationResult.fromVersion} → v${migrationResult.toVersion}`);
        if (migrationResult.backup) {
          warnings.push(`升级前备份: ${migrationResult.backup.filename}`);
        }
      } else if (migrationResult && migrationResult.action === "none_needed") {
        warnings.push(`数据已是最新版本 v${migrationResult.toVersion}`);
      } else if (migrationResult && migrationResult.action === "initialized") {
        warnings.push(`数据库已初始化`);
      }

      const backupVersion = backup.data.schemaVersion ?? 0;
      return {
        success: true,
        restoredFrom: filename,
        restoredAt: new Date().toISOString(),
        dataCounts: validation.dataCounts,
        restoreImpact: diff.summary || null,
        diff: diff.diff || null,
        warnings,
        migrationResult,
        finalVersion: migrationResult?.toVersion ?? backupVersion
      };
    } finally {
      try {
        await unlink(tempFile);
      } catch {
      }
    }
  }

  return {
    createBackup,
    listBackups,
    readBackupFile,
    validateBackup,
    computeBackupDiff,
    restoreFromBackup,
    sanitizeBackupFilename,
    validateDataStructure,
    getDataCounts
  };
}

module.exports = { createBackupManager, BACKUP_ERRORS, BACKUP_FILENAME_PATTERN };
