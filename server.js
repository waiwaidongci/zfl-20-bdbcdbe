const http = require("http");
const { readFile, writeFile, mkdir, readdir, stat, unlink, rename, copyFile } = require("fs/promises");
const path = require("path");
const migrator = require("./data-migrator");

const PORT = Number(process.env.PORT || 3020);
const DB_FILE = path.join(__dirname, "data", "db.json");
const AUDIT_LOG_FILE = path.join(__dirname, "data", "audit-logs.json");
const BACKUP_DIR = path.join(__dirname, "data", "backups");

const AUDIT_ACTION_TYPES = {
  CREATE_RUBBING: "create_rubbing",
  REGISTER_DAMAGE: "register_damage",
  UPDATE_DAMAGE: "update_damage",
  APPROVE_DAMAGE: "approve_damage",
  REJECT_DAMAGE: "reject_damage",
  CREATE_BATCH: "create_batch",
  COMPLETE_BATCH: "complete_batch",
  ROLLBACK_BATCH: "rollback_batch",
  PARTIAL_ROLLBACK_BATCH: "partial_rollback_batch",
  ARCHIVE_IMAGES: "archive_images",
  RESTORE_BACKUP: "restore_backup",
  IMPORT_CONFIRM: "import_confirm"
};

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

const VALID_REPAIR_STATUSES = ["pending", "in_repair", "repaired"];
const VALID_REVIEW_STATUSES = ["review_pending", "approved", "rejected"];
const VALID_BATCH_STATUSES = ["open", "completed", "partially_rolled_back"];

const precheckTokenStore = new Map();
const PRECHECK_TOKEN_TTL = 5 * 60 * 1000;

const writeQueue = { _chain: Promise.resolve() };

function enqueueWrite(writeFn) {
  const promise = writeQueue._chain.then(() => writeFn());
  writeQueue._chain = promise.catch(() => {});
  return promise;
}

function getWriteVersion(raw) {
  return raw?.meta?.writeVersion ?? 0;
}

function attachVersion(data, version) {
  Object.defineProperty(data, "__writeVersion", {
    value: version,
    writable: true,
    enumerable: false,
    configurable: true
  });
  return data;
}

function createVersionConflictError(expectedVersion, currentVersion) {
  const error = new Error(
    `数据版本冲突：您所基于的数据版本（v${expectedVersion}）已被其他请求修改（当前版本 v${currentVersion}）。请刷新后重试。`
  );
  error.code = "VERSION_CONFLICT";
  error.status = 409;
  error.expectedVersion = expectedVersion;
  error.currentVersion = currentVersion;
  return error;
}

const initialData = {
  rubbings: [
    {
      id: "rubbing_demo",
      code: "TP-清-014",
      source: "地方碑刻残页",
      paperSize: "42x68cm",
      note: "边缘有旧折痕",
      createdAt: new Date().toISOString()
    }
  ],
  damages: [
    {
      id: "damage_demo_1",
      rubbingId: "rubbing_demo",
      position: "左上角第3列题字旁",
      type: "虫蛀孔",
      beforePhotoUrl: "https://example.local/before-014-1.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      reviewStatus: "approved",
      rejectReason: "",
      reviewedBy: "系统初始化",
      reviewedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      repairedAt: null
    },
    {
      id: "damage_demo_2",
      rubbingId: "rubbing_demo",
      position: "下边缘中央",
      type: "撕裂",
      beforePhotoUrl: "https://example.local/before-014-2.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      reviewStatus: "review_pending",
      rejectReason: "",
      reviewedBy: null,
      reviewedAt: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    }
  ],
  batches: [],
  repairImages: [],
  batchSnapshots: []
};

const routes = [
  "GET /health",
  "GET /schema-version",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=&reviewStatus=",
  "PATCH /damages/:id",
  "POST /damages/:id/approve",
  "POST /damages/:id/reject",
  "GET /damages/:id/images",
  "POST /damages/:id/images",
  "GET /batches?status=&responsible=",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete",
  "POST /batches/:id/rollback",
  "POST /batches/:id/rollback {damageIds} (partial)",
  "POST /import/precheck",
  "POST /import/confirm",
  "GET /dashboard/repair-workbench?type=&rubbingId=&batchId=&responsible=",
  "GET /rubbings/:id/summary",
  "GET /schedules?startDate=&endDate=&status=&responsible=",
  "GET /export/rubbings?startDate=&endDate=&fields=",
  "GET /export/damages?status=&type=&startDate=&endDate=&fields=",
  "GET /export/batches?status=&startDate=&endDate=&fields=",
  "GET /export/repair-results?status=&type=&startDate=&endDate=&fields=",
  "GET /backups",
  "POST /backups",
  "GET /backups/:filename/validate",
  "GET /backups/:filename/diff",
  "POST /backups/:filename/restore",
  "GET /audit-logs?actionType=&targetId=&targetType=&startDate=&endDate=&success=",
  "GET /audit-trail?eventType=&targetId=&targetType=&startDate=&endDate=&actor="
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  let content;
  try {
    content = await readFile(DB_FILE, "utf8");
  } catch (readError) {
    if (readError.code !== "ENOENT") {
      throw readError;
    }
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
    return;
  }
  try {
    JSON.parse(content);
  } catch (parseError) {
    const error = new Error(`数据库JSON损坏，拒绝自动覆盖: ${parseError.message}`);
    error.code = "JSON_CORRUPTED";
    error.status = 500;
    throw error;
  }
}

function unwrapDbData(raw) {
  if (!raw || typeof raw !== "object") {
    return { rubbings: [], damages: [], batches: [], repairImages: [], batchSnapshots: [], auditTrail: [] };
  }
  if (typeof raw.schemaVersion === "number" && raw.entities) {
    return {
      rubbings: raw.entities.rubbings || [],
      damages: raw.entities.damages || [],
      batches: raw.entities.batches || [],
      repairImages: raw.entities.repairImages || [],
      batchSnapshots: raw.entities.batchSnapshots || [],
      auditTrail: raw.auditTrail || []
    };
  }
  if (!raw.repairImages) raw.repairImages = [];
  if (!raw.batchSnapshots) raw.batchSnapshots = [];
  if (!raw.auditTrail) raw.auditTrail = [];
  return raw;
}

async function readDb() {
  await ensureDb();
  let raw;
  try {
    raw = JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch (parseErr) {
    console.error(`[readDb] JSON 解析失败，使用空数据: ${parseErr.message}`);
    return attachVersion({ rubbings: [], damages: [], batches: [], repairImages: [], batchSnapshots: [] }, 0);
  }
  const version = getWriteVersion(raw);
  const data = unwrapDbData(raw);
  return attachVersion(data, version);
}

function makeAuditEventId() {
  return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function writeAuditTrailEvent(event) {
  return enqueueWrite(async () => {
    let raw;
    try {
      raw = JSON.parse(await readFile(DB_FILE, "utf8"));
    } catch (error) {
      console.warn(`[writeAuditTrailEvent] 读取数据库失败，跳过事件写入: ${error.message}`);
      return null;
    }

    if (!raw || typeof raw !== "object" || typeof raw.schemaVersion !== "number" || raw.schemaVersion < 3) {
      return null;
    }

    if (!Array.isArray(raw.auditTrail)) {
      raw.auditTrail = [];
    }

    const fullEvent = {
      id: makeAuditEventId(),
      eventType: event.eventType,
      targetType: event.targetType || null,
      targetId: event.targetId || null,
      timestamp: new Date().toISOString(),
      actor: event.actor || null,
      oldValues: event.oldValues || null,
      newValues: event.newValues || null,
      reason: event.reason || null,
      metadata: event.metadata || {}
    };

    const currentVersion = getWriteVersion(raw);
    raw.auditTrail.push(fullEvent);
    raw.meta.dataStatistics.auditTrailEvents = raw.auditTrail.length;
    raw.meta.lastModifiedAt = new Date().toISOString();
    raw.meta.writeVersion = currentVersion + 1;

    const tempFile = path.join(path.dirname(DB_FILE), `.db.tmp.audit.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.json`);
    try {
      const jsonStr = JSON.stringify(raw, null, 2);
      await writeFile(tempFile, jsonStr);
      JSON.parse(await readFile(tempFile, "utf8"));
      try {
        await rename(tempFile, DB_FILE);
      } catch (renameErr) {
        if (renameErr.code === "EXDEV" || renameErr.code === "EPERM") {
          await copyFile(tempFile, DB_FILE);
          await unlink(tempFile);
        } else {
          throw renameErr;
        }
      }
      return fullEvent;
    } catch (error) {
      console.warn(`[writeAuditTrailEvent] 写入事件失败: ${error.message}`);
      try {
        await unlink(tempFile);
      } catch (_) {
      }
      return null;
    }
  });
}

async function writeDb(data) {
  const expectedVersion = data.__writeVersion;

  return enqueueWrite(async () => {
    let raw;
    try {
      raw = JSON.parse(await readFile(DB_FILE, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        raw = null;
      } else {
        const writeError = new Error(`写入被阻断：当前数据库JSON损坏 - ${error.message}`);
        writeError.code = "JSON_CORRUPTED";
        throw writeError;
      }
    }

    const currentVersion = getWriteVersion(raw);
    if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
      throw createVersionConflictError(expectedVersion, currentVersion);
    }

    let toWrite;
    if (raw && typeof raw === "object" && typeof raw.schemaVersion === "number" && raw.entities) {
      const version = raw.schemaVersion;
      raw.entities = {
        rubbings: data.rubbings || [],
        damages: data.damages || [],
        batches: data.batches || [],
        repairImages: data.repairImages || [],
        batchSnapshots: data.batchSnapshots || []
      };
      raw.meta.lastModifiedAt = new Date().toISOString();
      raw.meta.writeVersion = currentVersion + 1;

      if (version >= 3) {
        raw.meta.dataStatistics = {
          rubbings: raw.entities.rubbings.length,
          damages: raw.entities.damages.length,
          batches: raw.entities.batches.length,
          repairImages: raw.entities.repairImages.length,
          batchSnapshots: raw.entities.batchSnapshots.length,
          auditTrailEvents: (raw.auditTrail || []).length
        };
        raw.imageArchive.summary = migrator.rebuildImageArchiveStats(raw.entities);
        if (!Array.isArray(raw.auditTrail)) {
          raw.auditTrail = [];
        }
        const v3Errors = migrator.validateV3Structure(raw);
        if (v3Errors.length > 0) {
          throw new Error(`写入被阻断：v3 结构校验失败 - ${v3Errors.join("; ")}`);
        }
      } else {
        raw.meta.dataStatistics = {
          rubbings: raw.entities.rubbings.length,
          damages: raw.entities.damages.length,
          batches: raw.entities.batches.length,
          repairImages: raw.entities.repairImages.length,
          batchSnapshots: raw.entities.batchSnapshots.length
        };
        const v2Errors = migrator.validateV2Structure(raw);
        if (v2Errors.length > 0) {
          throw new Error(`写入被阻断：v2 结构校验失败 - ${v2Errors.join("; ")}`);
        }
      }
      toWrite = raw;
    } else {
      if (!data || typeof data !== "object") {
        throw new Error("写入被阻断：数据不是有效对象");
      }
      toWrite = data;
      if (!toWrite.meta) toWrite.meta = {};
      toWrite.meta.writeVersion = currentVersion + 1;
    }

    const tempFile = path.join(path.dirname(DB_FILE), `.db.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.json`);
    try {
      const jsonStr = JSON.stringify(toWrite, null, 2);
      await writeFile(tempFile, jsonStr);
      JSON.parse(await readFile(tempFile, "utf8"));
      try {
        await rename(tempFile, DB_FILE);
      } catch (renameErr) {
        if (renameErr.code === "EXDEV" || renameErr.code === "EPERM") {
          await copyFile(tempFile, DB_FILE);
          await unlink(tempFile);
        } else {
          throw renameErr;
        }
      }
    } catch (e) {
      try {
        await unlink(tempFile);
      } catch (_) {
      }
      throw e;
    }

    if (data && typeof data === "object") {
      attachVersion(data, currentVersion + 1);
    }
  });
}

async function ensureAuditLog() {
  await mkdir(path.dirname(AUDIT_LOG_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(AUDIT_LOG_FILE, "utf8"));
  } catch {
    await writeFile(AUDIT_LOG_FILE, JSON.stringify([], null, 2));
  }
}

async function readAuditLog() {
  await ensureAuditLog();
  return JSON.parse(await readFile(AUDIT_LOG_FILE, "utf8"));
}

async function writeAuditLog(logs) {
  await writeFile(AUDIT_LOG_FILE, JSON.stringify(logs, null, 2));
}

async function writeAuditEntry(entry) {
  const logs = await readAuditLog();
  logs.push({
    id: makeId("audit"),
    timestamp: new Date().toISOString(),
    ...entry
  });
  await writeAuditLog(logs);
}

function buildChangeSummary(actionType, oldValues, newValues, extra) {
  switch (actionType) {
    case AUDIT_ACTION_TYPES.CREATE_RUBBING:
      return `创建拓片：编号 ${newValues.code}，来源 ${newValues.source}`;
    case AUDIT_ACTION_TYPES.REGISTER_DAMAGE:
      return `登记缺损：位置 ${newValues.position}，类型 ${newValues.type}，所属拓片 ${newValues.rubbingId}`;
    case AUDIT_ACTION_TYPES.UPDATE_DAMAGE: {
      const changes = [];
      if (oldValues.position !== newValues.position) changes.push(`位置: ${oldValues.position} → ${newValues.position}`);
      if (oldValues.type !== newValues.type) changes.push(`类型: ${oldValues.type} → ${newValues.type}`);
      if (oldValues.status !== newValues.status) changes.push(`状态: ${oldValues.status} → ${newValues.status}`);
      if (oldValues.repairNote !== newValues.repairNote) changes.push(`修补说明已更新`);
      if (oldValues.afterPhotoUrl !== newValues.afterPhotoUrl) changes.push(`修补后照片已更新`);
      return `更新缺损：${changes.length > 0 ? changes.join("; ") : "无字段变更"}`;
    }
    case AUDIT_ACTION_TYPES.APPROVE_DAMAGE:
      return `审核通过：缺损 ${newValues.id}，审核人 ${newValues.reviewedBy || "系统审核"}，状态 ${oldValues.reviewStatus} → ${newValues.reviewStatus}`;
    case AUDIT_ACTION_TYPES.REJECT_DAMAGE:
      return `审核驳回：缺损 ${newValues.id}，审核人 ${newValues.reviewedBy || "系统审核"}，驳回原因：${newValues.rejectReason || "未填写"}`;
    case AUDIT_ACTION_TYPES.CREATE_BATCH:
      return `创建批次：${newValues.name}，包含 ${newValues.damageIds.length} 项缺损`;
    case AUDIT_ACTION_TYPES.COMPLETE_BATCH: {
      const base = `完成批次：${newValues.name}，共完成 ${newValues.damageIds.length} 项缺损修补`;
      if (extra?.archivedImageCount > 0) {
        return `${base}，归档影像 ${extra.archivedImageCount} 张`;
      }
      return base;
    }
    case AUDIT_ACTION_TYPES.ROLLBACK_BATCH:
      return `回滚批次：${oldValues.name}，恢复 ${oldValues.damageIds.length} 项缺损状态`;
    case AUDIT_ACTION_TYPES.PARTIAL_ROLLBACK_BATCH:
      return `部分回滚批次：${newValues.name}，回滚 ${extra.rolledBackCount} 项缺损（批次状态：${getStatusText(newValues.status)}）`;
    case AUDIT_ACTION_TYPES.ARCHIVE_IMAGES: {
      const count = extra?.imageCount || (Array.isArray(newValues) ? newValues.length : 0);
      const damageId = extra?.damageId || (newValues && newValues[0]?.damageId) || "unknown";
      return `影像归档：缺损 ${damageId}，新增 ${count} 张影像`;
    }
    case AUDIT_ACTION_TYPES.RESTORE_BACKUP: {
      const base = `备份恢复：从 ${oldValues.filename} 恢复，拓片 ${oldValues.dataCounts?.rubbings || "?"} 张，缺损 ${oldValues.dataCounts?.damages || "?"} 项`;
      if (extra?.restoreImpact) {
        return `${base}；${extra.restoreImpact.restoreImpact || ""}`;
      }
      return base;
    }
    case AUDIT_ACTION_TYPES.IMPORT_CONFIRM: {
      const imported = extra?.imported || { rubbings: 0, damages: 0 };
      const skipped = extra?.skipped || { rubbings: 0, damages: 0 };
      return `导入确认：成功导入拓片 ${imported.rubbings} 张、缺损 ${imported.damages} 项；跳过拓片 ${skipped.rubbings} 张、缺损 ${skipped.damages} 项`;
    }
    default:
      return `${actionType}: target ${newValues?.id || "unknown"}`;
  }
}

async function executeWithAudit({ actionType, targetType, targetId, oldValues, newValues, extra, businessResult, statusCode, res, success = true }) {
  try {
    const changeSummary = buildChangeSummary(actionType, oldValues, newValues, extra);
    await writeAuditEntry({
      actionType,
      targetType,
      targetId,
      success,
      changeSummary,
      oldValues: oldValues || null,
      newValues: newValues || null,
      extra: extra || null
    });

    const eventTypeMap = {
      create_rubbing: "rubbing_created",
      register_damage: "damage_registered",
      update_damage: "damage_updated",
      approve_damage: "damage_approved",
      reject_damage: "damage_rejected",
      create_batch: "batch_created",
      complete_batch: "batch_completed",
      rollback_batch: "batch_rolled_back",
      partial_rollback_batch: "batch_partially_rolled_back",
      archive_images: "images_archived",
      restore_backup: "backup_restored",
      import_confirm: "data_imported"
    };

    const reason = (newValues && newValues.rejectReason) || (extra && extra.reason) || null;
    const actor = (newValues && newValues.reviewedBy) || (extra && extra.actor) || null;

    await writeAuditTrailEvent({
      eventType: eventTypeMap[actionType] || actionType || "unknown_event",
      targetType: targetType || null,
      targetId: targetId || null,
      actor,
      oldValues: oldValues || null,
      newValues: newValues || null,
      reason,
      metadata: {
        changeSummary,
        success,
        extra: extra || null
      }
    });

    return send(res, statusCode, businessResult);
  } catch (auditError) {
    return send(res, 500, {
      error: "业务操作成功，但审计日志写入失败，操作已完成但无法追踪",
      auditError: auditError.message || "未知错误",
      businessData: businessResult
    });
  }
}

function queryAuditLogs(logs, { actionType, targetId, targetType, startDate, endDate, success } = {}) {
  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate) : null;
  if (start && isNaN(start.getTime())) return [];
  if (end && isNaN(end.getTime())) return [];

  return logs.filter((entry) => {
    if (actionType && entry.actionType !== actionType) return false;
    if (targetId && entry.targetId !== targetId) return false;
    if (targetType && entry.targetType !== targetType) return false;
    if (success !== undefined && success !== null && entry.success !== success) return false;
    if (start || end) {
      const entryTime = new Date(entry.timestamp);
      if (start && entryTime < start) return false;
      if (end && entryTime > end) return false;
    }
    return true;
  }).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

async function ensureBackupDir() {
  await mkdir(BACKUP_DIR, { recursive: true });
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
  const resolved = path.resolve(BACKUP_DIR, filename);
  if (!resolved.startsWith(path.resolve(BACKUP_DIR) + path.sep) && resolved !== path.resolve(BACKUP_DIR)) {
    const error = new Error("备份文件路径越界");
    error.code = BACKUP_ERRORS.BACKUP_NOT_FOUND;
    error.status = 400;
    throw error;
  }
  return filename;
}

async function createBackup() {
  await ensureBackupDir();
  const dbContent = await readFile(DB_FILE, "utf8");
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
  const backupPath = path.join(BACKUP_DIR, filename);
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
  const files = await readdir(BACKUP_DIR);
  const backupFiles = files.filter((f) => BACKUP_FILENAME_PATTERN.test(f));
  const backups = [];
  for (const filename of backupFiles) {
    try {
      const backupPath = path.join(BACKUP_DIR, filename);
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
  const backupPath = path.join(BACKUP_DIR, filename);
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
  const stats = await stat(path.join(BACKUP_DIR, filename));
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
  const tempFile = path.join(BACKUP_DIR, `temp_restore_${Date.now()}.json`);

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
        currentRaw = JSON.parse(await readFile(DB_FILE, "utf8"));
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

      const dbTempFile = path.join(path.dirname(DB_FILE), `.db.tmp.restore.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.json`);
      try {
        await writeFile(dbTempFile, JSON.stringify(dataToWrite, null, 2));
        JSON.parse(await readFile(dbTempFile, "utf8"));
        try {
          await rename(dbTempFile, DB_FILE);
        } catch (renameErr) {
          if (renameErr.code === "EXDEV" || renameErr.code === "EPERM") {
            await copyFile(dbTempFile, DB_FILE);
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

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRepairStatus(status) {
  return VALID_REPAIR_STATUSES.includes(status) ? status : "pending";
}

function normalizeReviewStatus(status) {
  if (status === undefined || status === null) {
    return "approved";
  }
  return VALID_REVIEW_STATUSES.includes(status) ? status : "review_pending";
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function getImportPayloadSignature(body) {
  return stableStringify({
    rubbings: Array.isArray(body.rubbings) ? body.rubbings : [],
    damages: Array.isArray(body.damages) ? body.damages : []
  });
}

function createPrecheckToken(body) {
  const token = makeId("precheck");
  const expiresAt = Date.now() + PRECHECK_TOKEN_TTL;
  precheckTokenStore.set(token, {
    expiresAt,
    payloadSignature: getImportPayloadSignature(body)
  });
  return token;
}

function validatePrecheckToken(token, body) {
  if (!token) return false;
  const entry = precheckTokenStore.get(token);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    precheckTokenStore.delete(token);
    return false;
  }
  if (entry.payloadSignature !== getImportPayloadSignature(body)) return false;
  return true;
}

function consumePrecheckToken(token, body) {
  if (!validatePrecheckToken(token, body)) return false;
  precheckTokenStore.delete(token);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of precheckTokenStore) {
    if (now > entry.expiresAt) precheckTokenStore.delete(token);
  }
}, 60 * 1000);

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function normalizeDamage(damage) {
  return {
    ...damage,
    status: normalizeRepairStatus(damage.status),
    reviewStatus: normalizeReviewStatus(damage.reviewStatus),
    rejectReason: damage.rejectReason || "",
    reviewedBy: damage.reviewedBy || null,
    reviewedAt: damage.reviewedAt || null
  };
}

function normalizeRepairImage(img) {
  return {
    ...img,
    isPrimary: img.isPrimary === true
  };
}

const VALID_STAGES = ["before_repair", "during_repair", "after_repair"];

function groupImagesByStage(images) {
  const grouped = { before_repair: [], during_repair: [], after_repair: [] };
  images.forEach((img) => {
    if (grouped[img.stage]) {
      grouped[img.stage].push(normalizeRepairImage(img));
    }
  });
  return grouped;
}

function validatePrimaryImageConstraints(db, damageId, stage, isPrimary, excludeImageId = null) {
  if (!isPrimary) return [];
  const errors = [];
  const existingPrimary = db.repairImages.find(
    (img) =>
      img.damageId === damageId &&
      img.stage === stage &&
      img.isPrimary === true &&
      img.id !== excludeImageId
  );
  if (existingPrimary) {
    errors.push(`缺损项 ${damageId} 的 ${stage} 阶段已存在主图（${existingPrimary.id}），同一阶段只能有一张主图`);
  }
  return errors;
}

function validateBatchPrimaryImageConstraints(db, images) {
  const errors = [];
  const primaryKeyMap = new Map();

  images.forEach((img, idx) => {
    if (!img.isPrimary) return;
    const key = `${img.damageId}_${img.stage}`;
    if (primaryKeyMap.has(key)) {
      const existingIdx = primaryKeyMap.get(key);
      errors.push(`第${existingIdx + 1}张和第${idx + 1}张影像都标记为 ${img.damageId} ${img.stage} 阶段的主图，同一阶段只能有一张主图`);
    } else {
      primaryKeyMap.set(key, idx);
    }

    const dbErrors = validatePrimaryImageConstraints(db, img.damageId, img.stage, true);
    if (dbErrors.length) {
      errors.push(...dbErrors.map((e) => `第${idx + 1}张影像：${e}`));
    }
  });

  return errors;
}

function isValidImageUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function validateImageEntry(entry, index) {
  const errors = [];
  if (!entry.stage || !VALID_STAGES.includes(entry.stage)) {
    errors.push(`第${index + 1}张图片阶段无效，必须是 before_repair / during_repair / after_repair`);
  }
  if (!entry.url || typeof entry.url !== "string" || entry.url.trim() === "") {
    errors.push(`第${index + 1}张图片URL不能为空`);
  } else if (!isValidImageUrl(entry.url.trim())) {
    errors.push(`第${index + 1}张图片URL格式无效，必须是有效的 http 或 https 链接`);
  }
  if (entry.isPrimary !== undefined && entry.isPrimary !== null && typeof entry.isPrimary !== "boolean") {
    errors.push(`第${index + 1}张图片 isPrimary 必须是布尔值`);
  }
  return errors;
}

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) {
    const error = new Error("拓片不存在");
    error.status = 404;
    throw error;
  }
  return rubbing;
}

function enrichBatch(db, batch) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id)).map((damage) => {
  const normalized = normalizeDamage(damage);
  const images = db.repairImages.filter((img) => img.damageId === damage.id);
  return { ...normalized, images: groupImagesByStage(images) };
});
  return {
    ...batch,
    plannedStartAt: batch.plannedStartAt || null,
    plannedEndAt: batch.plannedEndAt || null,
    responsible: batch.responsible || null,
    rolledBackDamageIds: batch.rolledBackDamageIds || [],
    damages,
    total: damages.length,
    repaired: damages.filter((item) => item.status === "repaired").length,
    pending: damages.filter((item) => item.status !== "repaired").length
  };
}

function computeRepairWorkbenchDashboard(db, filters = {}) {
  const { type, rubbingId, batchId, responsible } = filters;
  const hasResponsibleFilter = responsible !== undefined && responsible !== null;

  const filteredBatches = db.batches.filter((b) => {
    if (batchId) return b.id === batchId;
    if (rubbingId) return b.damageIds.some((did) => db.damages.find((d) => d.id === did && d.rubbingId === rubbingId));
    if (hasResponsibleFilter) {
      const batchResp = b.responsible || null;
      if (responsible === "") {
        return batchResp === null;
      } else {
        return batchResp === responsible;
      }
    }
    return true;
  });

  const filteredBatchIds = new Set(filteredBatches.map((b) => b.id));

  const filteredDamages = db.damages.filter((damage) => {
    if (type && damage.type !== type) return false;
    if (rubbingId && damage.rubbingId !== rubbingId) return false;
    if (batchId && damage.batchId !== batchId) return false;
    if (hasResponsibleFilter && damage.batchId) return filteredBatchIds.has(damage.batchId);
    if (hasResponsibleFilter && !damage.batchId) return false;
    return true;
  });

  const statusCounts = {
    pending: filteredDamages.filter((d) => d.status === "pending").length,
    in_repair: filteredDamages.filter((d) => d.status === "in_repair").length,
    repaired: filteredDamages.filter((d) => d.status === "repaired").length,
    total: filteredDamages.length
  };

  const typeMap = new Map();
  filteredDamages.forEach((damage) => {
    if (!typeMap.has(damage.type)) {
      typeMap.set(damage.type, {
        type: damage.type,
        total: 0,
        pending: 0,
        in_repair: 0,
        repaired: 0
      });
    }
    const entry = typeMap.get(damage.type);
    entry.total += 1;
    entry[damage.status] = (entry[damage.status] || 0) + 1;
  });

  const byType = Array.from(typeMap.values()).sort((a, b) => b.total - a.total);

  const now = new Date();
  const byResponsibleMap = new Map();
  filteredBatches.forEach((batch) => {
    const resp = batch.responsible || "未分配";
    if (!byResponsibleMap.has(resp)) {
      byResponsibleMap.set(resp, {
        responsible: resp,
        batchCount: 0,
        damageCount: 0,
        overdueCount: 0,
        openBatchCount: 0,
        completedBatchCount: 0
      });
    }
    const entry = byResponsibleMap.get(resp);
    entry.batchCount += 1;
    const batchDamageCount = batch.damageIds.length;
    entry.damageCount += batchDamageCount;
    if (batch.status === "open") entry.openBatchCount += 1;
    if (batch.status === "completed") entry.completedBatchCount += 1;
    if (batch.status === "partially_rolled_back") entry.completedBatchCount += 1;
    if (batch.status === "open" && batch.plannedEndAt && new Date(batch.plannedEndAt) < now) {
      entry.overdueCount += 1;
    }
  });

  const byResponsible = Array.from(byResponsibleMap.values()).sort((a, b) => b.batchCount - a.batchCount);

  return {
    statusCounts,
    byType,
    totalTypes: byType.length,
    activeBatches: filteredBatches.filter((b) => b.status === "open").length,
    completedBatches: filteredBatches.filter((b) => b.status === "completed" || b.status === "partially_rolled_back").length,
    partiallyRolledBackBatches: filteredBatches.filter((b) => b.status === "partially_rolled_back").length,
    byResponsible
  };
}

function parseScheduleRangeDate(value, isEndDate = false) {
  const date = new Date(value);
  if (isNaN(date.getTime())) return null;
  if (isEndDate && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date;
}

function parseDateRange(value, isEndDate = false) {
  if (!value) return null;
  const date = new Date(value);
  if (isNaN(date.getTime())) return null;
  if (isEndDate && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date;
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes("\"") || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, "\"\"")}"`;
  }
  return str;
}

function generateCsv(headers, rows) {
  const headerLine = headers.map((h) => escapeCsvValue(h.label)).join(",");
  const bodyLines = rows.map((row) =>
    headers.map((h) => {
      const value = row[h.key] !== undefined ? row[h.key] : "";
      return escapeCsvValue(value);
    }).join(",")
  );
  return [headerLine, ...bodyLines].join("\r\n");
}

function filterByDateRange(items, startDate, endDate, dateField = "createdAt") {
  return items.filter((item) => {
    const itemDate = new Date(item[dateField]);
    if (startDate && itemDate < startDate) return false;
    if (endDate && itemDate > endDate) return false;
    return true;
  });
}

function parseFieldsParam(fieldsStr) {
  if (!fieldsStr || typeof fieldsStr !== "string") return null;
  const trimmed = fieldsStr.trim();
  if (!trimmed) return null;
  return trimmed.split(",").map((f) => f.trim()).filter((f) => f.length > 0);
}

function validateAndFilterHeaders(allHeaders, requestedFields, resourceName) {
  if (!requestedFields) return allHeaders;

  const validKeys = new Set(allHeaders.map((h) => h.key));
  const invalidFields = requestedFields.filter((f) => !validKeys.has(f));

  if (invalidFields.length > 0) {
    const error = new Error(
      `非法字段：${invalidFields.join(", ")}。${resourceName}可用字段：${allHeaders.map((h) => h.key).join(", ")}`
    );
    error.status = 400;
    error.code = "INVALID_FIELDS";
    error.invalidFields = invalidFields;
    error.validFields = allHeaders.map((h) => h.key);
    throw error;
  }

  return requestedFields.map((key) => allHeaders.find((h) => h.key === key));
}

function getStatusText(status) {
  const statusMap = {
    pending: "待修补",
    in_repair: "修补中",
    repaired: "已修补",
    open: "进行中",
    completed: "已完成",
    partially_rolled_back: "部分已回滚",
    approved: "已通过",
    rejected: "已驳回",
    review_pending: "待审核"
  };
  return statusMap[status] || status || "";
}

function exportRubbingsCsv(db, filters = {}) {
  const { startDate, endDate, fields } = filters;
  const start = parseDateRange(startDate);
  const end = parseDateRange(endDate, true);
  const requestedFields = parseFieldsParam(fields);

  let rubbings = filterByDateRange(db.rubbings, start, end);

  const allHeaders = [
    { key: "id", label: "拓片ID" },
    { key: "code", label: "拓片编号" },
    { key: "source", label: "来源" },
    { key: "paperSize", label: "纸张尺寸" },
    { key: "note", label: "备注" },
    { key: "damageCount", label: "缺损总数" },
    { key: "pendingCount", label: "待修补数" },
    { key: "inRepairCount", label: "修补中数" },
    { key: "repairedCount", label: "已修补数" },
    { key: "createdAt", label: "创建时间" }
  ];

  const headers = validateAndFilterHeaders(allHeaders, requestedFields, "拓片");

  const rows = rubbings.map((rubbing) => {
    const damages = db.damages.filter((d) => d.rubbingId === rubbing.id);
    return {
      id: rubbing.id,
      code: rubbing.code,
      source: rubbing.source,
      paperSize: rubbing.paperSize,
      note: rubbing.note || "",
      damageCount: damages.length,
      pendingCount: damages.filter((d) => d.status === "pending").length,
      inRepairCount: damages.filter((d) => d.status === "in_repair").length,
      repairedCount: damages.filter((d) => d.status === "repaired").length,
      createdAt: rubbing.createdAt
    };
  });

  return generateCsv(headers, rows);
}

function exportDamagesCsv(db, filters = {}) {
  const { status, type, startDate, endDate, fields } = filters;
  const start = parseDateRange(startDate);
  const end = parseDateRange(endDate, true);
  const requestedFields = parseFieldsParam(fields);

  let damages = db.damages.filter((d) => {
    if (status && d.status !== status) return false;
    if (type && d.type !== type) return false;
    return true;
  });
  damages = filterByDateRange(damages, start, end);

  const rubbingMap = new Map(db.rubbings.map((r) => [r.id, r]));
  const batchMap = new Map(db.batches.map((b) => [b.id, b]));

  const allHeaders = [
    { key: "id", label: "缺损ID" },
    { key: "rubbingCode", label: "拓片编号" },
    { key: "rubbingSource", label: "拓片来源" },
    { key: "position", label: "缺损位置" },
    { key: "type", label: "缺损类型" },
    { key: "statusText", label: "修补状态" },
    { key: "reviewStatusText", label: "审核状态" },
    { key: "reviewedBy", label: "审核人" },
    { key: "reviewedAt", label: "审核时间" },
    { key: "batchName", label: "所属批次" },
    { key: "repairNote", label: "修补说明" },
    { key: "rejectReason", label: "驳回原因" },
    { key: "beforePhotoUrl", label: "修补前照片" },
    { key: "afterPhotoUrl", label: "修补后照片" },
    { key: "createdAt", label: "创建时间" },
    { key: "repairedAt", label: "修补完成时间" }
  ];

  const headers = validateAndFilterHeaders(allHeaders, requestedFields, "缺损项");

  const rows = damages.map((damage) => {
    const rubbing = rubbingMap.get(damage.rubbingId) || {};
    const batch = damage.batchId ? batchMap.get(damage.batchId) : null;
    return {
      id: damage.id,
      rubbingCode: rubbing.code || "",
      rubbingSource: rubbing.source || "",
      position: damage.position,
      type: damage.type,
      statusText: getStatusText(damage.status),
      reviewStatusText: getStatusText(damage.reviewStatus),
      reviewedBy: damage.reviewedBy || "",
      reviewedAt: damage.reviewedAt || "",
      batchName: batch ? batch.name : "",
      repairNote: damage.repairNote || "",
      rejectReason: damage.rejectReason || "",
      beforePhotoUrl: damage.beforePhotoUrl || "",
      afterPhotoUrl: damage.afterPhotoUrl || "",
      createdAt: damage.createdAt,
      repairedAt: damage.repairedAt || ""
    };
  });

  return generateCsv(headers, rows);
}

function exportBatchesCsv(db, filters = {}) {
  const { status, startDate, endDate, fields } = filters;
  const start = parseDateRange(startDate);
  const end = parseDateRange(endDate, true);
  const requestedFields = parseFieldsParam(fields);

  let batches = db.batches.filter((b) => {
    if (status && b.status !== status) return false;
    return true;
  });
  batches = filterByDateRange(batches, start, end);

  const allHeaders = [
    { key: "id", label: "批次ID" },
    { key: "name", label: "批次名称" },
    { key: "statusText", label: "批次状态" },
    { key: "totalDamages", label: "缺损总数" },
    { key: "pendingCount", label: "待修补数" },
    { key: "inRepairCount", label: "修补中数" },
    { key: "repairedCount", label: "已修补数" },
    { key: "responsible", label: "负责人" },
    { key: "plannedStartAt", label: "计划开始时间" },
    { key: "plannedEndAt", label: "计划结束时间" },
    { key: "note", label: "备注" },
    { key: "createdAt", label: "创建时间" },
    { key: "completedAt", label: "完成时间" }
  ];

  const headers = validateAndFilterHeaders(allHeaders, requestedFields, "批次");

  const rows = batches.map((batch) => {
    const damages = db.damages.filter((d) => batch.damageIds.includes(d.id));
    return {
      id: batch.id,
      name: batch.name,
      statusText: getStatusText(batch.status),
      totalDamages: damages.length,
      pendingCount: damages.filter((d) => d.status === "pending").length,
      inRepairCount: damages.filter((d) => d.status === "in_repair").length,
      repairedCount: damages.filter((d) => d.status === "repaired").length,
      responsible: batch.responsible || "",
      plannedStartAt: batch.plannedStartAt || "",
      plannedEndAt: batch.plannedEndAt || "",
      note: batch.note || "",
      createdAt: batch.createdAt,
      completedAt: batch.completedAt || ""
    };
  });

  return generateCsv(headers, rows);
}

function exportRepairResultsCsv(db, filters = {}) {
  const { status, type, startDate, endDate, fields } = filters;
  const start = parseDateRange(startDate);
  const end = parseDateRange(endDate, true);
  const requestedFields = parseFieldsParam(fields);

  let damages = db.damages.filter((d) => {
    if (status && d.status !== status) return false;
    if (type && d.type !== type) return false;
    return true;
  });
  damages = filterByDateRange(damages, start, end, "repairedAt");

  const rubbingMap = new Map(db.rubbings.map((r) => [r.id, r]));
  const batchMap = new Map(db.batches.map((b) => [b.id, b]));
  const imagesMap = new Map();
  db.repairImages.forEach((img) => {
    const normalizedImg = normalizeRepairImage(img);
    if (!imagesMap.has(img.damageId)) {
      imagesMap.set(img.damageId, { before_repair: [], during_repair: [], after_repair: [] });
    }
    if (imagesMap.get(img.damageId)[img.stage]) {
      imagesMap.get(img.damageId)[img.stage].push(normalizedImg);
    }
  });

  const allHeaders = [
    { key: "id", label: "缺损ID" },
    { key: "rubbingCode", label: "拓片编号" },
    { key: "rubbingSource", label: "拓片来源" },
    { key: "position", label: "缺损位置" },
    { key: "type", label: "缺损类型" },
    { key: "statusText", label: "修补状态" },
    { key: "reviewStatusText", label: "审核状态" },
    { key: "reviewedBy", label: "审核人" },
    { key: "reviewedAt", label: "审核时间" },
    { key: "batchName", label: "所属批次" },
    { key: "repairNote", label: "修补说明" },
    { key: "beforeImageCount", label: "修补前影像数" },
    { key: "duringImageCount", label: "修补中影像数" },
    { key: "afterImageCount", label: "修补后影像数" },
    { key: "primaryBeforeImageUrl", label: "修补前主图URL" },
    { key: "primaryDuringImageUrl", label: "修补中主图URL" },
    { key: "primaryAfterImageUrl", label: "修补后主图URL" },
    { key: "beforePhotoUrl", label: "修补前照片" },
    { key: "afterPhotoUrl", label: "修补后照片" },
    { key: "createdAt", label: "创建时间" },
    { key: "repairedAt", label: "修补完成时间" }
  ];

  const headers = validateAndFilterHeaders(allHeaders, requestedFields, "修补结果");

  const rows = damages.map((damage) => {
    const rubbing = rubbingMap.get(damage.rubbingId) || {};
    const batch = damage.batchId ? batchMap.get(damage.batchId) : null;
    const images = imagesMap.get(damage.id) || { before_repair: [], during_repair: [], after_repair: [] };
    const primaryBefore = images.before_repair.find((img) => img.isPrimary);
    const primaryDuring = images.during_repair.find((img) => img.isPrimary);
    const primaryAfter = images.after_repair.find((img) => img.isPrimary);
    return {
      id: damage.id,
      rubbingCode: rubbing.code || "",
      rubbingSource: rubbing.source || "",
      position: damage.position,
      type: damage.type,
      statusText: getStatusText(damage.status),
      reviewStatusText: getStatusText(damage.reviewStatus),
      reviewedBy: damage.reviewedBy || "",
      reviewedAt: damage.reviewedAt || "",
      batchName: batch ? batch.name : "",
      repairNote: damage.repairNote || "",
      beforeImageCount: images.before_repair.length,
      duringImageCount: images.during_repair.length,
      afterImageCount: images.after_repair.length,
      primaryBeforeImageUrl: primaryBefore ? primaryBefore.url : "",
      primaryDuringImageUrl: primaryDuring ? primaryDuring.url : "",
      primaryAfterImageUrl: primaryAfter ? primaryAfter.url : "",
      beforePhotoUrl: damage.beforePhotoUrl || "",
      afterPhotoUrl: damage.afterPhotoUrl || "",
      createdAt: damage.createdAt,
      repairedAt: damage.repairedAt || ""
    };
  });

  return generateCsv(headers, rows);
}

function sendCsv(res, filename, content) {
  const encodedFilename = encodeURIComponent(filename);
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodedFilename}`,
    "Content-Length": Buffer.byteLength("\uFEFF" + content, "utf8")
  });
  res.end("\uFEFF" + content);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", routes });
  }

  if (req.method === "GET" && pathname === "/schema-version") {
    let raw;
    try {
      raw = JSON.parse(await readFile(DB_FILE, "utf8"));
    } catch (e) {
      return send(res, 200, { schemaVersion: null, currentSupported: migrator.CURRENT_SCHEMA_VERSION });
    }
    return send(res, 200, {
      schemaVersion: raw.schemaVersion || 0,
      currentSupported: migrator.CURRENT_SCHEMA_VERSION,
      isLatest: raw.schemaVersion === migrator.CURRENT_SCHEMA_VERSION,
      meta: raw.meta || null,
      imageArchiveSummary: raw.imageArchive?.summary || null,
      auditTrailCount: (raw.auditTrail || []).length
    });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter((item) => item.status !== "repaired").length
      };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/rubbings") {
    const body = await parseBody(req);
    required(body, ["code", "source", "paperSize"]);
    const rubbing = {
      id: makeId("rubbing"),
      code: body.code,
      source: body.source,
      paperSize: body.paperSize,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.rubbings.push(rubbing);
    await writeDb(db);
    return executeWithAudit({
      actionType: AUDIT_ACTION_TYPES.CREATE_RUBBING,
      targetType: "rubbing",
      targetId: rubbing.id,
      newValues: rubbing,
      businessResult: { data: rubbing },
      statusCode: 201,
      res
    });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingId).map(normalizeDamage) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl"]);
    const damage = {
      id: makeId("damage"),
      rubbingId,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      reviewStatus: "review_pending",
      rejectReason: "",
      reviewedBy: null,
      reviewedAt: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    };
    db.damages.push(damage);
    await writeDb(db);
    return executeWithAudit({
      actionType: AUDIT_ACTION_TYPES.REGISTER_DAMAGE,
      targetType: "damage",
      targetId: damage.id,
      newValues: damage,
      businessResult: { data: damage },
      statusCode: 201,
      res
    });
  }

  const summaryMatch = pathname.match(/^\/rubbings\/([^/]+)\/summary$/);
  if (summaryMatch && req.method === "GET") {
    const rubbingId = summaryMatch[1];
    const rubbing = findRubbing(db, rubbingId);
    const damages = db.damages.filter((item) => item.rubbingId === rubbingId).map(normalizeDamage);
    const batchIds = [...new Set(damages.map((d) => d.batchId).filter(Boolean))];
    const batches = batchIds.map((bid) => {
      const batch = db.batches.find((b) => b.id === bid);
      if (!batch) return null;
      return {
        id: batch.id,
        name: batch.name,
        status: batch.status,
        total: batch.damageIds.length,
        repaired: batch.damageIds.filter((did) => {
          const d = db.damages.find((item) => item.id === did);
          return d && d.status === "repaired";
        }).length,
        completedAt: batch.completedAt
      };
    }).filter(Boolean);
    const total = damages.length;
    const repaired = damages.filter((item) => item.status === "repaired").length;
    const repairProgress = {
      total,
      repaired,
      pending: damages.filter((item) => item.status === "pending").length,
      inRepair: damages.filter((item) => item.status === "in_repair").length,
      percentage: total === 0 ? 100 : Math.round((repaired / total) * 100)
    };
    return send(res, 200, {
      data: {
        rubbing,
        damages,
        batches,
        hasUnbatchedDamages: damages.some((d) => !d.batchId),
        repairProgress
      }
    });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const reviewStatus = url.searchParams.get("reviewStatus");
    const data = db.damages
      .map(normalizeDamage)
      .filter((item) => (!status || item.status === status) && (!type || item.type === type) && (!reviewStatus || item.reviewStatus === reviewStatus));
    return send(res, 200, { data });
  }

  const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damagePatchMatch && req.method === "PATCH") {
    const damage = db.damages.find((item) => item.id === damagePatchMatch[1]);
    if (!damage) return send(res, 404, { error: "缺损项不存在" });
    const oldValues = { ...damage };
    const body = await parseBody(req);
    Object.assign(damage, {
      position: body.position ?? damage.position,
      type: body.type ?? damage.type,
      beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl,
      afterPhotoUrl: body.afterPhotoUrl ?? damage.afterPhotoUrl,
      status: body.status !== undefined ? normalizeRepairStatus(body.status) : damage.status,
      repairNote: body.repairNote ?? damage.repairNote
    });
    damage.repairedAt = damage.status === "repaired" ? new Date().toISOString() : damage.repairedAt;
    await writeDb(db);
    const images = db.repairImages.filter((img) => img.damageId === damage.id);
    const responseData = { data: { ...normalizeDamage(damage), images: groupImagesByStage(images) } };
    return executeWithAudit({
      actionType: AUDIT_ACTION_TYPES.UPDATE_DAMAGE,
      targetType: "damage",
      targetId: damage.id,
      oldValues,
      newValues: { ...damage },
      businessResult: responseData,
      statusCode: 200,
      res
    });
  }

  const approveMatch = pathname.match(/^\/damages\/([^/]+)\/approve$/);
  if (approveMatch && req.method === "POST") {
    const damage = db.damages.find((item) => item.id === approveMatch[1]);
    if (!damage) return send(res, 404, { error: "缺损项不存在" });
    const normalized = normalizeDamage(damage);
    if (normalized.reviewStatus !== "review_pending") {
      return send(res, 400, { error: "当前审核状态不是待审核，无法执行审核通过操作" });
    }
    const body = await parseBody(req);
    const oldValues = { ...damage };
    damage.reviewStatus = "approved";
    damage.rejectReason = "";
    damage.reviewedBy = body.reviewedBy || "系统审核";
    damage.reviewedAt = new Date().toISOString();
    await writeDb(db);
    const businessResult = { data: normalizeDamage(damage) };
    return executeWithAudit({
      actionType: AUDIT_ACTION_TYPES.APPROVE_DAMAGE,
      targetType: "damage",
      targetId: damage.id,
      oldValues,
      newValues: { ...damage },
      businessResult,
      statusCode: 200,
      res
    });
  }

  const rejectMatch = pathname.match(/^\/damages\/([^/]+)\/reject$/);
  if (rejectMatch && req.method === "POST") {
    const damage = db.damages.find((item) => item.id === rejectMatch[1]);
    if (!damage) return send(res, 404, { error: "缺损项不存在" });
    const normalized = normalizeDamage(damage);
    if (normalized.reviewStatus !== "review_pending") {
      return send(res, 400, { error: "当前审核状态不是待审核，无法执行审核驳回操作" });
    }
    const body = await parseBody(req);
    if (!body.reason || typeof body.reason !== "string" || body.reason.trim() === "") {
      return send(res, 400, { error: "驳回原因不能为空" });
    }
    const oldValues = { ...damage };
    damage.reviewStatus = "rejected";
    damage.rejectReason = body.reason.trim();
    damage.reviewedBy = body.reviewedBy || "系统审核";
    damage.reviewedAt = new Date().toISOString();
    await writeDb(db);
    const businessResult = { data: normalizeDamage(damage) };
    return executeWithAudit({
      actionType: AUDIT_ACTION_TYPES.REJECT_DAMAGE,
      targetType: "damage",
      targetId: damage.id,
      oldValues,
      newValues: { ...damage },
      businessResult,
      statusCode: 200,
      res
    });
  }

  const damageImagesMatch = pathname.match(/^\/damages\/([^/]+)\/images$/);
  if (damageImagesMatch) {
    const damageId = damageImagesMatch[1];
    const damage = db.damages.find((item) => item.id === damageId);
    if (!damage) return send(res, 404, { error: "缺损项不存在" });

    if (req.method === "GET") {
      const images = db.repairImages.filter((img) => img.damageId === damageId);
      return send(res, 200, { data: groupImagesByStage(images) });
    }

    if (req.method === "POST") {
      const body = await parseBody(req);
      const imagesInput = Array.isArray(body.images) ? body.images : [body];
      if (imagesInput.length === 0) {
        return send(res, 400, { error: "images不能为空数组" });
      }

      const allErrors = [];
      imagesInput.forEach((entry, idx) => {
        allErrors.push(...validateImageEntry(entry, idx));
      });
      if (allErrors.length) {
        return send(res, 400, { error: allErrors.join("; ") });
      }

      const batchImagesWithDamageId = imagesInput.map((img) => ({ ...img, damageId }));
      const primaryErrors = validateBatchPrimaryImageConstraints(db, batchImagesWithDamageId);
      if (primaryErrors.length) {
        return send(res, 400, { error: primaryErrors.join("; ") });
      }

      const created = [];
      const createdRecords = [];
      imagesInput.forEach((entry) => {
        const record = {
          id: makeId("img"),
          damageId,
          stage: entry.stage,
          url: entry.url.trim(),
          capturedAt: entry.capturedAt || new Date().toISOString(),
          description: entry.description || "",
          collector: entry.collector || "",
          isPrimary: entry.isPrimary === true,
          createdAt: new Date().toISOString()
        };
        db.repairImages.push(record);
        createdRecords.push(record);
        created.push(normalizeRepairImage(record));
      });

      await writeDb(db);
      const businessResult = { data: created };
      return executeWithAudit({
        actionType: AUDIT_ACTION_TYPES.ARCHIVE_IMAGES,
        targetType: "damage",
        targetId: damageId,
        newValues: createdRecords,
        extra: { damageId, imageCount: createdRecords.length },
        businessResult,
        statusCode: 201,
        res
      });
    }
  }

  if (req.method === "GET" && pathname === "/batches") {
    const statusFilter = url.searchParams.get("status");
    const responsibleFilter = url.searchParams.get("responsible");
    const data = db.batches
      .filter((batch) => {
        if (statusFilter && batch.status !== statusFilter) return false;
        if (responsibleFilter !== null && responsibleFilter !== undefined) {
          const batchResp = batch.responsible || null;
          if (responsibleFilter === "") {
            if (batchResp !== null) return false;
          } else {
            if (batchResp !== responsibleFilter) return false;
          }
        }
        return true;
      })
      .map((batch) => enrichBatch(db, batch));
    return send(res, 200, { data, total: data.length });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) return send(res, 400, { error: "damageIds必须是非空数组" });
    const invalid = body.damageIds.filter((id) => !db.damages.find((damage) => damage.id === id));
    if (invalid.length) return send(res, 400, { error: `缺损项不存在：${invalid.join(", ")}` });

    const unapprovedDamageIds = body.damageIds.filter((id) => {
      const damage = db.damages.find((d) => d.id === id);
      const normalized = normalizeDamage(damage);
      return normalized.reviewStatus !== "approved";
    });
    if (unapprovedDamageIds.length) {
      return send(res, 400, {
        error: "以下缺损项尚未通过审核，不能加入修补批次",
        unapprovedDamageIds
      });
    }

    const scheduledDamageIds = new Set();
    db.damages.forEach((d) => {
      if (d.batchId) {
        const batch = db.batches.find((b) => b.id === d.batchId);
        if (batch && batch.status !== "completed") {
          scheduledDamageIds.add(d.id);
        }
      }
    });
    const conflictDamageIds = body.damageIds.filter((did) => scheduledDamageIds.has(did));
    if (conflictDamageIds.length) {
      return send(res, 400, {
        error: "以下缺损项已存在于未完成批次中，不能重复排程",
        conflictDamageIds
      });
    }

    const batch = {
      id: makeId("batch"),
      name: body.name,
      status: "open",
      damageIds: body.damageIds,
      note: body.note || "",
      plannedStartAt: body.plannedStartAt || null,
      plannedEndAt: body.plannedEndAt || null,
      responsible: body.responsible || null,
      rolledBackDamageIds: [],
      createdAt: new Date().toISOString(),
      completedAt: null
    };
    db.batches.push(batch);
    db.damages.forEach((damage) => {
      if (body.damageIds.includes(damage.id)) {
        damage.batchId = batch.id;
        damage.status = "in_repair";
      }
    });
    await writeDb(db);
    const enrichedBatch = enrichBatch(db, batch);
    return executeWithAudit({
      actionType: AUDIT_ACTION_TYPES.CREATE_BATCH,
      targetType: "batch",
      targetId: batch.id,
      newValues: batch,
      businessResult: { data: enrichedBatch },
      statusCode: 201,
      res
    });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = db.batches.find((item) => item.id === batchMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const batch = db.batches.find((item) => item.id === completeMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    const oldValues = { ...batch };
    const body = await parseBody(req);
    const results = Array.isArray(body.results) ? body.results : [];
    const archiveImages = Array.isArray(body.archiveImages) ? body.archiveImages : [];

    if (archiveImages.length > 0) {
      const batchDamageIdSet = new Set(batch.damageIds);
      const ownershipErrors = [];
      const stageUrlErrors = [];

      archiveImages.forEach((entry, idx) => {
        if (!entry.damageId || !batchDamageIdSet.has(entry.damageId)) {
          ownershipErrors.push(`第${idx + 1}条影像的缺损项 ${entry.damageId || "null"} 不属于当前批次`);
        }
        const entryErrors = validateImageEntry(entry, idx);
        if (entryErrors.length) {
          stageUrlErrors.push(...entryErrors);
        }
      });

      if (ownershipErrors.length) {
        return send(res, 400, { error: `影像归档归属校验失败：${ownershipErrors.join("; ")}` });
      }
      if (stageUrlErrors.length) {
        return send(res, 400, { error: stageUrlErrors.join("; ") });
      }

      const primaryErrors = validateBatchPrimaryImageConstraints(db, archiveImages);
      if (primaryErrors.length) {
        return send(res, 400, { error: `影像主图约束校验失败：${primaryErrors.join("; ")}` });
      }
    }

    const batchDamageSnapshots = {};
    batch.damageIds.forEach((did) => {
      const d = db.damages.find((x) => x.id === did);
      if (d) batchDamageSnapshots[did] = JSON.parse(JSON.stringify(d));
    });

    const addedImageIds = [];
    if (archiveImages.length > 0) {
      archiveImages.forEach((entry) => {
        const record = {
          id: makeId("img"),
          damageId: entry.damageId,
          stage: entry.stage,
          url: entry.url.trim(),
          capturedAt: entry.capturedAt || new Date().toISOString(),
          description: entry.description || "",
          collector: entry.collector || "",
          isPrimary: entry.isPrimary === true,
          createdAt: new Date().toISOString()
        };
        addedImageIds.push(record.id);
        db.repairImages.push(record);
      });
    }

    const existingSnapshotIdx = db.batchSnapshots.findIndex((s) => s.batchId === batch.id);
    let snapshot;
    if (existingSnapshotIdx >= 0 && batch.status !== "partially_rolled_back") {
      const existing = db.batchSnapshots[existingSnapshotIdx];
      snapshot = {
        ...existing,
        id: makeId("snap"),
        createdAt: new Date().toISOString(),
        addedImageIds: [...(existing.addedImageIds || []), ...addedImageIds]
      };
      db.batchSnapshots[existingSnapshotIdx] = snapshot;
    } else if (existingSnapshotIdx >= 0 && batch.status === "partially_rolled_back") {
      const existing = db.batchSnapshots[existingSnapshotIdx];
      const rolledBackSet = new Set(batch.rolledBackDamageIds || []);
      const mergedDamagesBefore = {};
      batch.damageIds.forEach((did) => {
        if (rolledBackSet.has(did)) {
          mergedDamagesBefore[did] = batchDamageSnapshots[did];
        } else {
          mergedDamagesBefore[did] = (existing.damagesBefore && existing.damagesBefore[did])
            ? existing.damagesBefore[did]
            : batchDamageSnapshots[did];
        }
      });
      const survivedImageIds = (existing.addedImageIds || []).filter(
        (id) => !(existing.removedImageIds || []).includes(id)
      );
      snapshot = {
        id: makeId("snap"),
        batchId: batch.id,
        createdAt: new Date().toISOString(),
        batchBefore: existing.batchBefore || JSON.parse(JSON.stringify(batch)),
        damagesBefore: mergedDamagesBefore,
        addedImageIds: [...survivedImageIds, ...addedImageIds],
        removedImageIds: []
      };
      db.batchSnapshots[existingSnapshotIdx] = snapshot;
    } else {
      snapshot = {
        id: makeId("snap"),
        batchId: batch.id,
        createdAt: new Date().toISOString(),
        batchBefore: JSON.parse(JSON.stringify(batch)),
        damagesBefore: batchDamageSnapshots,
        addedImageIds,
        removedImageIds: []
      };
      db.batchSnapshots.push(snapshot);
    }

    batch.status = "completed";
    batch.completedAt = new Date().toISOString();
    batch.note = body.note ?? batch.note;
    batch.rolledBackDamageIds = [];
    db.damages.forEach((damage) => {
      if (!batch.damageIds.includes(damage.id)) return;
      const result = results.find((item) => item.damageId === damage.id) || {};
      damage.status = "repaired";
      damage.batchId = batch.id;
      damage.afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
      damage.repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
      damage.repairedAt = new Date().toISOString();
    });
    await writeDb(db);
    const enrichedBatch = enrichBatch(db, batch);
    return executeWithAudit({
      actionType: AUDIT_ACTION_TYPES.COMPLETE_BATCH,
      targetType: "batch",
      targetId: batch.id,
      oldValues,
      newValues: { ...batch },
      extra: { archivedImageCount: addedImageIds.length, snapshotId: snapshot.id },
      businessResult: { data: enrichedBatch, snapshotId: snapshot.id },
      statusCode: 200,
      res
    });
  }

  const rollbackMatch = pathname.match(/^\/batches\/([^/]+)\/rollback$/);
  if (rollbackMatch && req.method === "POST") {
    const batchId = rollbackMatch[1];
    const batch = db.batches.find((item) => item.id === batchId);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });

    const body = await parseBody(req);
    const requestedDamageIds = Array.isArray(body.damageIds) && body.damageIds.length > 0 ? body.damageIds : null;
    const isPartialRollback = requestedDamageIds !== null;

    if (batch.status !== "completed" && batch.status !== "partially_rolled_back") {
      return send(res, 400, {
        error: `批次当前状态为「${getStatusText(batch.status)}」，只能回滚已完成或部分已回滚的批次`,
        code: "INVALID_BATCH_STATUS_FOR_ROLLBACK"
      });
    }

    const snapshot = db.batchSnapshots.find((s) => s.batchId === batchId);
    if (!snapshot) {
      return send(res, 400, {
        error: `无法回滚批次 ${batch.name}：未找到完成时的快照数据。该批次可能是在回滚功能上线前完成的旧数据，不支持回滚操作。如需恢复请联系管理员通过备份还原。`,
        code: "SNAPSHOT_NOT_FOUND",
        hint: "旧批次数据无快照，仅支持功能上线后新完成的批次回滚"
      });
    }

    function checkReferenceConflicts(damageIdsToCheck) {
      const batchCompletedAt = batch.completedAt ? new Date(batch.completedAt) : null;
      const refs = [];
      db.batches.forEach((other) => {
        if (other.id === batchId) return;
        const otherCompletedAt = other.completedAt ? new Date(other.completedAt) : null;
        if (!otherCompletedAt || !batchCompletedAt) return;
        if (otherCompletedAt <= batchCompletedAt) return;
        const overlap = other.damageIds.filter((did) => damageIdsToCheck.includes(did));
        if (overlap.length > 0) {
          refs.push({
            batchId: other.id,
            batchName: other.name,
            completedAt: other.completedAt,
            overlappingDamageIds: overlap
          });
        }
      });
      return refs;
    }

    if (isPartialRollback) {
      const batchDamageIdSet = new Set(batch.damageIds);
      const notInBatch = requestedDamageIds.filter((id) => !batchDamageIdSet.has(id));
      if (notInBatch.length > 0) {
        return send(res, 400, {
          error: `以下缺损项不属于当前批次：${notInBatch.join(", ")}`,
          code: "DAMAGE_NOT_IN_BATCH"
        });
      }

      const alreadyRolledBack = new Set(batch.rolledBackDamageIds || []);
      const alreadyRolled = requestedDamageIds.filter((id) => alreadyRolledBack.has(id));
      if (alreadyRolled.length > 0) {
        return send(res, 400, {
          error: `以下缺损项已回滚，不能重复回滚：${alreadyRolled.join(", ")}`,
          code: "ALREADY_ROLLED_BACK"
        });
      }

      const referencedBy = checkReferenceConflicts(requestedDamageIds);
      if (referencedBy.length > 0) {
        const details = referencedBy
          .map((r) => `批次「${r.batchName}」(${r.batchId}，完成于 ${r.completedAt}) 引用了缺损项: ${r.overlappingDamageIds.join(", ")}`)
          .join("；");
        return send(res, 409, {
          error: `无法部分回滚批次 ${batch.name}：指定的缺损项仍被 ${referencedBy.length} 个后续完成的批次引用。${details}`,
          code: "DAMAGE_REFERENCED_BY_LATER_BATCH",
          referencedBy
        });
      }

      const oldValues = JSON.parse(JSON.stringify(batch));

      requestedDamageIds.forEach((did) => {
        const savedDamage = snapshot.damagesBefore[did];
        const damage = db.damages.find((d) => d.id === did);
        if (damage && savedDamage) {
          Object.assign(damage, {
            status: savedDamage.status,
            afterPhotoUrl: savedDamage.afterPhotoUrl,
            repairNote: savedDamage.repairNote,
            repairedAt: savedDamage.repairedAt,
            batchId: null
          });
        }
      });

      const alreadyRemovedIds = new Set(snapshot.removedImageIds || []);
      const remainingImageIds = (snapshot.addedImageIds || []).filter((id) => !alreadyRemovedIds.has(id));
      const remainingImageIdSet = new Set(remainingImageIds);
      const imagesToRemove = remainingImageIds.filter((imgId) => {
        const img = db.repairImages.find((i) => i.id === imgId);
        return img && requestedDamageIds.includes(img.damageId);
      });
      if (imagesToRemove.length > 0) {
        const removeSet = new Set(imagesToRemove);
        db.repairImages = db.repairImages.filter((img) => !removeSet.has(img.id));
      }
      snapshot.removedImageIds = [...(snapshot.removedImageIds || []), ...imagesToRemove];

      batch.rolledBackDamageIds = [...(batch.rolledBackDamageIds || []), ...requestedDamageIds];

      const allRolledBack = batch.rolledBackDamageIds.length >= batch.damageIds.length;
      if (allRolledBack) {
        Object.assign(batch, {
          status: "open",
          completedAt: null,
          note: snapshot.batchBefore ? (snapshot.batchBefore.note ?? batch.note) : batch.note
        });
        batch.rolledBackDamageIds = [];
        db.batchSnapshots = db.batchSnapshots.filter((s) => s.batchId !== batchId);
      } else {
        batch.status = "partially_rolled_back";
      }

      await writeDb(db);
      const enrichedBatch = enrichBatch(db, batch);
      return executeWithAudit({
        actionType: AUDIT_ACTION_TYPES.PARTIAL_ROLLBACK_BATCH,
        targetType: "batch",
        targetId: batch.id,
        oldValues,
        newValues: { ...batch },
        extra: {
          rolledBackDamageIds: requestedDamageIds,
          rolledBackCount: requestedDamageIds.length,
          removedImageCount: imagesToRemove.length
        },
        businessResult: {
          data: enrichedBatch,
          rolledBackDamageCount: requestedDamageIds.length,
          removedImageCount: imagesToRemove.length,
          batchStatus: batch.status
        },
        statusCode: 200,
        res
      });
    }

    const referencedBy = checkReferenceConflicts(batch.damageIds);
    if (referencedBy.length > 0) {
      const details = referencedBy
        .map((r) => `批次「${r.batchName}」(${r.batchId}，完成于 ${r.completedAt}) 引用了缺损项: ${r.overlappingDamageIds.join(", ")}`)
        .join("；");
      return send(res, 409, {
        error: `无法回滚批次 ${batch.name}：该批次的缺损项仍被 ${referencedBy.length} 个后续完成的批次引用。${details}`,
        code: "DAMAGE_REFERENCED_BY_LATER_BATCH",
        referencedBy
      });
    }

    const oldValues = JSON.parse(JSON.stringify(batch));
    const alreadyRolledBackSet = new Set(batch.rolledBackDamageIds || []);
    const damagesToRollBack = batch.damageIds.filter((did) => !alreadyRolledBackSet.has(did));

    Object.assign(batch, {
      status: "open",
      completedAt: null
    });

    damagesToRollBack.forEach((did) => {
      const savedDamage = snapshot.damagesBefore[did];
      const damage = db.damages.find((d) => d.id === did);
      if (damage && savedDamage) {
        Object.assign(damage, {
          status: savedDamage.status,
          afterPhotoUrl: savedDamage.afterPhotoUrl,
          repairNote: savedDamage.repairNote,
          repairedAt: savedDamage.repairedAt,
          batchId: null
        });
      }
    });

    batch.damageIds.forEach((did) => {
      const damage = db.damages.find((d) => d.id === did);
      if (damage && damage.batchId === batchId) {
        damage.batchId = null;
      }
    });

    const alreadyRemoved = new Set(snapshot.removedImageIds || []);
    const imagesToRemove = (snapshot.addedImageIds || []).filter((id) => !alreadyRemoved.has(id));
    if (imagesToRemove.length > 0) {
      const removeSet = new Set(imagesToRemove);
      db.repairImages = db.repairImages.filter((img) => !removeSet.has(img.id));
    }

    batch.rolledBackDamageIds = [];
    db.batchSnapshots = db.batchSnapshots.filter((s) => s.batchId !== batchId);

    await writeDb(db);
    const enrichedBatch = enrichBatch(db, batch);
    return executeWithAudit({
      actionType: AUDIT_ACTION_TYPES.ROLLBACK_BATCH,
      targetType: "batch",
      targetId: batch.id,
      oldValues,
      newValues: { ...batch },
      businessResult: {
        data: enrichedBatch,
        restoredDamageCount: batch.damageIds.length,
        removedImageCount: imagesToRemove.length
      },
      statusCode: 200,
      res
    });
  }

  if (req.method === "GET" && pathname === "/dashboard/repair-workbench") {
    const type = url.searchParams.get("type");
    const rubbingId = url.searchParams.get("rubbingId");
    const batchId = url.searchParams.get("batchId");
    const responsible = url.searchParams.get("responsible");
    const data = computeRepairWorkbenchDashboard(db, { type, rubbingId, batchId, responsible });
    return send(res, 200, { data });
  }

  function validateImportSubmission(body, db) {
    const rubbings = Array.isArray(body.rubbings) ? body.rubbings : [];
    const damages = Array.isArray(body.damages) ? body.damages : [];

    const existingCodes = new Set(db.rubbings.map((r) => r.code));
    const submittedCodes = new Set();
    const validRubbingIndices = new Set();
    const rubbingResults = [];

    rubbings.forEach((rubbing, index) => {
      const rowIndex = rubbing.rowIndex !== undefined ? rubbing.rowIndex : index;
      const errors = [];
      const warnings = [];
      const missing = ["code", "source", "paperSize"].filter(
        (field) => rubbing[field] === undefined || rubbing[field] === ""
      );
      if (missing.length) {
        errors.push(`缺少必填字段: ${missing.join(", ")}`);
      } else {
        if (existingCodes.has(rubbing.code)) {
          errors.push(`拓片编号 "${rubbing.code}" 已存在于数据库中`);
        } else if (submittedCodes.has(rubbing.code)) {
          errors.push(`拓片编号 "${rubbing.code}" 在导入数据中重复出现`);
        } else {
          submittedCodes.add(rubbing.code);
          validRubbingIndices.add(index);
        }
      }
      if (rubbing.note && rubbing.note.length > 500) {
        warnings.push("备注内容超过500字符，可能被截断");
      }
      rubbingResults.push({
        rowIndex,
        status: errors.length === 0 ? "valid" : "invalid",
        errors,
        warnings,
        data: {
          code: rubbing.code || null,
          source: rubbing.source || null,
          paperSize: rubbing.paperSize || null,
          note: rubbing.note || ""
        }
      });
    });

    const existingRubbingIds = new Set(db.rubbings.map((r) => r.id));
    const existingRubbingCodes = new Set(db.rubbings.map((r) => r.code));
    const submittedRubbingRefs = new Map();
    rubbings.forEach((rubbing, index) => {
      if (validRubbingIndices.has(index) && rubbing.id) {
        submittedRubbingRefs.set(rubbing.id, index);
      }
      if (validRubbingIndices.has(index) && rubbing.code) {
        submittedRubbingRefs.set(rubbing.code, index);
      }
    });

    const validDamageIndices = new Set();
    const damageResults = [];

    damages.forEach((damage, index) => {
      const rowIndex = damage.rowIndex !== undefined ? damage.rowIndex : index;
      const errors = [];
      const warnings = [];
      const missing = ["position", "type", "beforePhotoUrl"].filter(
        (field) => damage[field] === undefined || damage[field] === ""
      );
      if (missing.length) {
        errors.push(`缺少必填字段: ${missing.join(", ")}`);
      }
      const rubbingRef = damage.rubbingId;
      let resolvedRubbingIndex = null;
      let resolvedRubbingRef = null;
      let resolvedRubbingSource = null;
      if (rubbingRef) {
        if (existingRubbingIds.has(rubbingRef)) {
          resolvedRubbingRef = rubbingRef;
          resolvedRubbingSource = "database";
          const matched = db.rubbings.find((r) => r.id === rubbingRef);
          if (matched) {
            resolvedRubbingIndex = matched.code;
          }
        } else if (existingRubbingCodes.has(rubbingRef)) {
          resolvedRubbingRef = rubbingRef;
          resolvedRubbingSource = "database";
          resolvedRubbingIndex = rubbingRef;
        } else if (submittedRubbingRefs.has(rubbingRef)) {
          resolvedRubbingRef = rubbingRef;
          resolvedRubbingSource = "import";
          const idx = submittedRubbingRefs.get(rubbingRef);
          resolvedRubbingIndex = rubbings[idx].code || rubbingRef;
        } else {
          errors.push(`关联的拓片 "${rubbingRef}" 不存在（既不在数据库中也不在本次导入的拓片数据中）`);
        }
      } else {
        errors.push("缺少关联拓片标识 rubbingId");
      }
      if (damage.reviewStatus && !VALID_REVIEW_STATUSES.includes(damage.reviewStatus)) {
        warnings.push(`审核状态 "${damage.reviewStatus}" 不是标准值，将使用默认值 review_pending`);
      }
      if (damage.status && !VALID_REPAIR_STATUSES.includes(damage.status)) {
        warnings.push(`修补状态 "${damage.status}" 不是标准值，将使用默认值 pending`);
      }
      if (errors.length === 0) {
        validDamageIndices.add(index);
      }
      damageResults.push({
        rowIndex,
        status: errors.length === 0 ? "valid" : "invalid",
        errors,
        warnings,
        data: {
          rubbingId: rubbingRef || null,
          position: damage.position || null,
          type: damage.type || null,
          beforePhotoUrl: damage.beforePhotoUrl || null,
          afterPhotoUrl: damage.afterPhotoUrl || "",
          status: damage.status || "pending",
          repairNote: damage.repairNote || "",
          reviewStatus: damage.reviewStatus || "review_pending",
          rejectReason: damage.rejectReason || ""
        },
        resolvedRubbing: resolvedRubbingRef
          ? {
              ref: resolvedRubbingRef,
              source: resolvedRubbingSource,
              identifier: resolvedRubbingIndex
            }
          : null
      });
    });

    return {
      rubbings,
      damages,
      importable: {
        rubbings: validRubbingIndices.size,
        damages: validDamageIndices.size
      },
      total: {
        rubbings: rubbings.length,
        damages: damages.length
      },
      rubbingResults,
      damageResults,
      validRubbingIndices,
      validDamageIndices,
      submittedRubbingRefs
    };
  }

  if (req.method === "POST" && pathname === "/import/precheck") {
    const body = await parseBody(req);
    const result = validateImportSubmission(body, db);
    const precheckToken = createPrecheckToken(body);
    return send(res, 200, {
      precheckToken,
      precheckTokenExpiresAt: Date.now() + PRECHECK_TOKEN_TTL,
      total: result.total,
      importable: result.importable,
      rubbings: result.rubbingResults,
      damages: result.damageResults
    });
  }

  if (req.method === "POST" && pathname === "/import/confirm") {
    const body = await parseBody(req);

    const tokenValid = consumePrecheckToken(body.precheckToken, body);
    if (!tokenValid) {
      return send(res, 400, {
        error: "导入确认失败：缺少、无效或与当前导入内容不匹配的预检令牌。请先调用 /import/precheck 进行预检，并在确认时返回同一导入内容对应的有效 precheckToken。",
        code: "MISSING_INVALID_OR_MISMATCHED_PRECHECK_TOKEN"
      });
    }

    const result = validateImportSubmission(body, db);
    const onlyValid = body.onlyValid !== false;

    const idMap = new Map();
    const rubbingRowMap = new Map();
    result.rubbings.forEach((rubbing, index) => {
      if (onlyValid && !result.validRubbingIndices.has(index)) return;
      const rowIndex = rubbing.rowIndex !== undefined ? rubbing.rowIndex : index;
      const newId = makeId("rubbing");
      if (rubbing.id) idMap.set(rubbing.id, newId);
      if (rubbing.code) idMap.set(rubbing.code, newId);
      const record = {
        id: newId,
        code: rubbing.code,
        source: rubbing.source,
        paperSize: rubbing.paperSize,
        note: rubbing.note || "",
        createdAt: new Date().toISOString()
      };
      db.rubbings.push(record);
      idMap.set(`idx_${index}`, newId);
      rubbingRowMap.set(rowIndex, { id: newId, code: rubbing.code });
    });

    const damageRowMap = new Map();
    const importedDamages = [];
    result.damages.forEach((damage, index) => {
      if (onlyValid && !result.validDamageIndices.has(index)) return;
      const rowIndex = damage.rowIndex !== undefined ? damage.rowIndex : index;
      let rubbingId = damage.rubbingId;
      if (idMap.has(rubbingId)) rubbingId = idMap.get(rubbingId);
      const record = {
        id: makeId("damage"),
        rubbingId,
        position: damage.position,
        type: damage.type,
        beforePhotoUrl: damage.beforePhotoUrl,
        afterPhotoUrl: damage.afterPhotoUrl || "",
        status: normalizeRepairStatus(damage.status),
        repairNote: damage.repairNote || "",
        batchId: null,
        reviewStatus: normalizeReviewStatus(damage.reviewStatus),
        rejectReason: damage.rejectReason || "",
        reviewedBy: damage.reviewedBy || null,
        reviewedAt: damage.reviewedAt || null,
        createdAt: new Date().toISOString(),
        repairedAt: null
      };
      db.damages.push(record);
      importedDamages.push(record);
      damageRowMap.set(rowIndex, { id: record.id, rubbingId });
    });

    await writeDb(db);

    const rubbingRowMapping = {};
    rubbingRowMap.forEach((value, key) => {
      rubbingRowMapping[key] = value;
    });
    const damageRowMapping = {};
    damageRowMap.forEach((value, key) => {
      damageRowMapping[key] = value;
    });

    const imported = {
      rubbings: rubbingRowMap.size,
      damages: damageRowMap.size
    };
    const skipped = {
      rubbings: result.rubbings.length - rubbingRowMap.size,
      damages: result.damages.length - damageRowMap.size
    };

    const businessResult = {
      imported,
      total: result.total,
      skipped,
      rowMapping: {
        rubbings: rubbingRowMapping,
        damages: damageRowMapping
      },
      onlyValid,
      normalized: {
        status: VALID_REPAIR_STATUSES,
        reviewStatus: VALID_REVIEW_STATUSES
      }
    };

    return executeWithAudit({
      actionType: AUDIT_ACTION_TYPES.IMPORT_CONFIRM,
      targetType: "import",
      targetId: "import_" + Date.now().toString(36),
      newValues: { imported, total: result.total, skipped, onlyValid },
      extra: { imported, skipped, total: result.total, onlyValid },
      businessResult,
      statusCode: 201,
      res
    });
  }

  if (req.method === "GET" && pathname === "/schedules") {
    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");
    const statusFilter = url.searchParams.get("status");
    const responsibleFilter = url.searchParams.get("responsible");

    if (!startDate || !endDate) {
      return send(res, 400, { error: "缺少参数：startDate 和 endDate 都是必需的" });
    }

    const start = parseScheduleRangeDate(startDate);
    const end = parseScheduleRangeDate(endDate, true);
    if (!start || !end) {
      return send(res, 400, { error: "日期格式无效，请使用 ISO 格式（如 2026-06-01 或 2026-06-01T00:00:00.000Z）" });
    }

    const schedules = db.batches.filter((batch) => {
      if (statusFilter && batch.status !== statusFilter) return false;

      if (responsibleFilter !== null && responsibleFilter !== undefined) {
        const batchResp = batch.responsible || null;
        if (responsibleFilter === "") {
          if (batchResp !== null) return false;
        } else {
          if (batchResp !== responsibleFilter) return false;
        }
      }

      const batchStart = batch.plannedStartAt ? new Date(batch.plannedStartAt) : null;
      const batchEnd = batch.plannedEndAt ? new Date(batch.plannedEndAt) : null;

      if (!batchStart && !batchEnd) return false;

      const effectiveStart = batchStart || new Date(batch.createdAt);
      const effectiveEnd = batchEnd || effectiveStart;

      return effectiveStart <= end && effectiveEnd >= start;
    }).map((batch) => enrichBatch(db, batch));

    schedules.sort((a, b) => {
      const aStart = a.plannedStartAt || a.createdAt;
      const bStart = b.plannedStartAt || b.createdAt;
      return new Date(aStart) - new Date(bStart);
    });

    return send(res, 200, {
      data: schedules,
      total: schedules.length,
      startDate: startDate,
      endDate: endDate
    });
  }

  if (req.method === "GET" && pathname === "/export/rubbings") {
    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");
    const fields = url.searchParams.get("fields");
    try {
      const csv = exportRubbingsCsv(db, { startDate, endDate, fields });
      const filename = `拓片数据_${new Date().toISOString().slice(0, 10)}.csv`;
      return sendCsv(res, filename, csv);
    } catch (error) {
      return send(res, error.status || 400, {
        error: error.message,
        code: error.code,
        invalidFields: error.invalidFields || undefined,
        validFields: error.validFields || undefined
      });
    }
  }

  if (req.method === "GET" && pathname === "/export/damages") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");
    const fields = url.searchParams.get("fields");
    try {
      const csv = exportDamagesCsv(db, { status, type, startDate, endDate, fields });
      const filename = `缺损项数据_${new Date().toISOString().slice(0, 10)}.csv`;
      return sendCsv(res, filename, csv);
    } catch (error) {
      return send(res, error.status || 400, {
        error: error.message,
        code: error.code,
        invalidFields: error.invalidFields || undefined,
        validFields: error.validFields || undefined
      });
    }
  }

  if (req.method === "GET" && pathname === "/export/batches") {
    const status = url.searchParams.get("status");
    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");
    const fields = url.searchParams.get("fields");
    try {
      const csv = exportBatchesCsv(db, { status, startDate, endDate, fields });
      const filename = `批次数据_${new Date().toISOString().slice(0, 10)}.csv`;
      return sendCsv(res, filename, csv);
    } catch (error) {
      return send(res, error.status || 400, {
        error: error.message,
        code: error.code,
        invalidFields: error.invalidFields || undefined,
        validFields: error.validFields || undefined
      });
    }
  }

  if (req.method === "GET" && pathname === "/export/repair-results") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");
    const fields = url.searchParams.get("fields");
    try {
      const csv = exportRepairResultsCsv(db, { status, type, startDate, endDate, fields });
      const filename = `修补结果数据_${new Date().toISOString().slice(0, 10)}.csv`;
      return sendCsv(res, filename, csv);
    } catch (error) {
      return send(res, error.status || 400, {
        error: error.message,
        code: error.code,
        invalidFields: error.invalidFields || undefined,
        validFields: error.validFields || undefined
      });
    }
  }

  if (req.method === "GET" && pathname === "/backups") {
    const backups = await listBackups();
    return send(res, 200, { data: backups, total: backups.length });
  }

  if (req.method === "POST" && pathname === "/backups") {
    try {
      const backup = await createBackup();
      return send(res, 201, { data: backup });
    } catch (error) {
      return send(res, error.status || 500, {
        error: error.message,
        code: error.code
      });
    }
  }

  const backupValidateMatch = pathname.match(/^\/backups\/([^/]+)\/validate$/);
  if (backupValidateMatch && req.method === "GET") {
    const filename = sanitizeBackupFilename(decodeURIComponent(backupValidateMatch[1]));
    try {
      const result = await validateBackup(filename);
      return send(res, 200, { data: result });
    } catch (error) {
      return send(res, error.status || 500, {
        error: error.message,
        code: error.code
      });
    }
  }

  const backupDiffMatch = pathname.match(/^\/backups\/([^/]+)\/diff$/);
  if (backupDiffMatch && req.method === "GET") {
    try {
      const filename = sanitizeBackupFilename(decodeURIComponent(backupDiffMatch[1]));
      const result = await computeBackupDiff(filename);
      if (result.error) {
        return send(res, 400, {
          data: result,
          error: result.error.message,
          code: result.error.code
        });
      }
      return send(res, 200, { data: result });
    } catch (error) {
      return send(res, error.status || 500, {
        error: error.message,
        code: error.code
      });
    }
  }

  const backupRestoreMatch = pathname.match(/^\/backups\/([^/]+)\/restore$/);
  if (backupRestoreMatch && req.method === "POST") {
    const filename = sanitizeBackupFilename(decodeURIComponent(backupRestoreMatch[1]));
    try {
      const body = await parseBody(req);
      let expectedVersion = db.__writeVersion;
      if (body && typeof body.expectedVersion === "number") {
        expectedVersion = body.expectedVersion;
      }

      let backupInfo;
      try {
        const backupValidation = await validateBackup(filename);
        backupInfo = {
          filename: backupValidation.filename,
          dataCounts: backupValidation.dataCounts,
          createdAt: backupValidation.createdAt,
          size: backupValidation.size
        };
      } catch {
        backupInfo = { filename, dataCounts: null, createdAt: null, size: null };
      }

      let precomputedDiff = null;
      try {
        precomputedDiff = await computeBackupDiff(filename);
      } catch (diffError) {
        precomputedDiff = null;
      }

      const result = await restoreFromBackup(filename, precomputedDiff, expectedVersion);
      const businessResult = { data: result };

      const auditExtra = {
        restoreImpact: result.restoreImpact,
        warnings: result.warnings
      };

      return executeWithAudit({
        actionType: AUDIT_ACTION_TYPES.RESTORE_BACKUP,
        targetType: "backup",
        targetId: filename,
        oldValues: backupInfo,
        newValues: { restoredAt: result.restoredAt, dataCounts: result.dataCounts },
        extra: auditExtra,
        businessResult,
        statusCode: 200,
        res
      });
    } catch (error) {
      return send(res, error.status || 500, {
        error: error.message,
        code: error.code
      });
    }
  }

  if (req.method === "GET" && pathname === "/audit-logs") {
    const actionType = url.searchParams.get("actionType");
    const targetId = url.searchParams.get("targetId");
    const targetType = url.searchParams.get("targetType");
    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");
    const successParam = url.searchParams.get("success");
    let success = undefined;
    if (successParam !== null && successParam !== undefined) {
      success = successParam === "true" || successParam === "1";
    }
    const logs = await readAuditLog();
    const filtered = queryAuditLogs(logs, { actionType, targetId, targetType, startDate, endDate, success });
    return send(res, 200, { data: filtered, total: filtered.length });
  }

  if (req.method === "GET" && pathname === "/audit-trail") {
    const eventType = url.searchParams.get("eventType");
    const targetId = url.searchParams.get("targetId");
    const targetType = url.searchParams.get("targetType");
    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");
    const actor = url.searchParams.get("actor");

    let rawDb;
    try {
      rawDb = JSON.parse(await readFile(DB_FILE, "utf8"));
    } catch (e) {
      return send(res, 200, { data: [], total: 0, schemaVersion: null });
    }

    const auditTrail = rawDb.auditTrail || [];
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;

    const filtered = auditTrail.filter((entry) => {
      if (eventType && entry.eventType !== eventType) return false;
      if (targetId && entry.targetId !== targetId) return false;
      if (targetType && entry.targetType !== targetType) return false;
      if (actor && entry.actor !== actor) return false;
      if (start || end) {
        const entryTime = new Date(entry.timestamp);
        if (start && entryTime < start) return false;
        if (end && entryTime > end) return false;
      }
      return true;
    }).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return send(res, 200, {
      data: filtered,
      total: filtered.length,
      schemaVersion: rawDb.schemaVersion || 0,
      hasV3Structure: rawDb.schemaVersion >= 3
    });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

(async function bootstrap() {
  let startupMode = "normal";
  let startupWarning = null;

  try {
    const migrationResult = await enqueueWrite(() => migrator.migrateToLatest());
    if (migrationResult.action === "migrated") {
      console.log(`[数据迁移] 成功: ${migrationResult.message}`);
      console.log(`[数据迁移] 从版本 v${migrationResult.fromVersion} 升级到 v${migrationResult.toVersion}`);
      if (migrationResult.backup) {
        console.log(`[数据迁移] 备份文件: ${migrationResult.backup.filename}`);
      }
      if (migrationResult.conflicts && migrationResult.conflicts.length > 0) {
        console.log(`[数据迁移] 潜在冲突警告 (${migrationResult.conflicts.length} 项):`);
        migrationResult.conflicts.forEach((c, i) => {
          console.log(`  ${i + 1}. [${c.level.toUpperCase()}] ${c.message}`);
        });
      }
    } else if (migrationResult.action === "initialized") {
      console.log(`[数据迁移] ${migrationResult.message}`);
    } else {
      console.log(`[数据迁移] ${migrationResult.message} (v${migrationResult.toVersion})`);
    }
  } catch (migrationError) {
    console.error(`[数据迁移] 失败: ${migrationError.message}`);
    if (migrationError.backupFile) {
      console.error(`[数据迁移] 备份文件: ${migrationError.backupFile}`);
    }

    switch (migrationError.code) {
      case "MIGRATION_AND_ROLLBACK_FAILED":
        console.error(`[数据迁移] 严重错误: 迁移和回滚均失败，数据可能已损坏！请从备份手动恢复`);
        startupMode = "fatal";
        startupWarning = "数据迁移严重失败，数据可能已损坏";
        break;
      case "V2_STRUCTURE_CORRUPTED":
        console.error(`[数据迁移] 错误: v2 结构校验失败，数据已损坏，拒绝启动`);
        if (migrationError.validationErrors) {
          migrationError.validationErrors.forEach((e, i) => {
            console.error(`  ${i + 1}. ${e}`);
          });
        }
        startupMode = "fatal";
        startupWarning = "v2 结构损坏，无法安全启动";
        break;
      case "V3_STRUCTURE_CORRUPTED":
        console.error(`[数据迁移] 错误: v3 结构校验失败，数据已损坏，拒绝启动`);
        if (migrationError.validationErrors) {
          migrationError.validationErrors.forEach((e, i) => {
            console.error(`  ${i + 1}. ${e}`);
          });
        }
        startupMode = "fatal";
        startupWarning = "v3 结构损坏，无法安全启动";
        break;
      case "INVALID_STRUCTURE":
        console.error(`[数据迁移] 错误: 数据结构无法识别，拒绝启动`);
        startupMode = "fatal";
        startupWarning = "数据结构无法识别";
        break;
      case "JSON_CORRUPTED":
        console.error(`[数据迁移] 错误: 数据库 JSON 损坏，拒绝启动`);
        startupMode = "fatal";
        startupWarning = "数据库文件 JSON 损坏";
        break;
      case "READ_FAILED":
        console.error(`[数据迁移] 错误: 数据库读取失败，拒绝启动`);
        startupMode = "fatal";
        startupWarning = "数据库文件读取失败";
        break;
      case "BACKUP_CREATION_FAILED":
        console.error(`[数据迁移] 警告: 备份创建失败，迁移已中止，将以原结构启动`);
        startupMode = "legacy";
        startupWarning = "备份创建失败，使用原始数据结构";
        break;
      case "MIGRATION_FAILED_ROLLED_BACK":
        console.error(`[数据迁移] 已回滚到原数据版本，将以旧结构启动`);
        startupMode = "legacy";
        startupWarning = "迁移失败已回滚，使用旧数据结构";
        break;
      case "MIGRATION_FAILED_NO_CHANGE":
        console.error(`[数据迁移] 迁移失败，数据未被修改，将以原结构启动`);
        startupMode = "legacy";
        startupWarning = "迁移失败，使用原始数据结构";
        break;
      default:
        console.error(`[数据迁移] 未知错误类型: ${migrationError.code}`);
        startupMode = "unknown_error";
        startupWarning = `迁移错误: ${migrationError.message}`;
    }
  }

  if (startupMode === "fatal") {
    console.error(`[启动中止] 数据处于不可恢复的损坏状态，请从备份文件手动恢复后再启动`);
    process.exit(1);
  }

  server.listen(PORT, () => {
    const modeSuffix = startupMode !== "normal" ? ` [${startupMode}]` : "";
    console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}${modeSuffix}`);
    if (startupWarning) {
      console.warn(`  警告: ${startupWarning}`);
    }
  });
})();
