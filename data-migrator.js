const { readFile, writeFile, mkdir, readdir, stat, copyFile, unlink, rename } = require("fs/promises");
const path = require("path");

const CURRENT_SCHEMA_VERSION = 3;
const MIN_SUPPORTED_VERSION = 0;

const DB_FILE = path.join(__dirname, "data", "db.json");
const BACKUP_DIR = path.join(__dirname, "data", "backups");
const AUDIT_LOG_FILE = path.join(__dirname, "data", "audit-logs.json");

const MIGRATION_BACKUP_PREFIX = "migration_backup_";

function pad(n, len = 2) {
  return String(n).padStart(len, "0");
}

function formatTimestamp(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`;
}

function getMigrationBackupFilename(timestamp, fromVersion, toVersion) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${MIGRATION_BACKUP_PREFIX}${timestamp}_v${fromVersion}tov${toVersion}_${suffix}.json`;
}

function isMigrationBackup(filename) {
  return filename.startsWith(MIGRATION_BACKUP_PREFIX) && filename.endsWith(".json");
}

function detectSchemaVersion(data) {
  if (!data || typeof data !== "object") {
    return { version: null, valid: false, reason: "数据不是有效对象" };
  }
  if (typeof data.schemaVersion === "number") {
    const version = data.schemaVersion;
    const structuralErrors = validateVersionedStructure(data, version);
    if (structuralErrors.length > 0) {
      return {
        version,
        valid: false,
        reason: `v${version} 结构损坏: ${structuralErrors.join("; ")}`
      };
    }
    return { version, valid: true, reason: null };
  }
  const legacyKeys = ["rubbings", "damages", "batches"];
  const hasLegacyStructure = legacyKeys.every((k) => Array.isArray(data[k]));
  if (hasLegacyStructure) {
    return { version: 0, valid: true, reason: "扁平结构（未版本化）" };
  }
  return { version: null, valid: false, reason: "无法识别的数据结构" };
}

function validateVersionedStructure(data, version) {
  const errors = [];
  if (!data || typeof data !== "object") {
    errors.push("根节点不是对象");
    return errors;
  }
  if (version === 1) {
    const required = ["rubbings", "damages", "batches"];
    const optional = ["repairImages", "batchSnapshots"];
    for (const k of required) {
      if (!Array.isArray(data[k])) {
        errors.push(`${k} 不是数组`);
      }
    }
    for (const k of optional) {
      if (data[k] !== undefined && !Array.isArray(data[k])) {
        errors.push(`${k} 不是数组`);
      }
    }
    return errors;
  }
  if (version === 2) {
    return validateV2Structure(data);
  }
  if (version === 3) {
    return validateV3Structure(data);
  }
  if (version > 3) {
    errors.push(`未知版本 v${version}，超出当前支持范围`);
  }
  return errors;
}

function buildV2EmptyStructure() {
  return {
    schemaVersion: 2,
    meta: {
      createdAt: null,
      lastModifiedAt: null,
      writeVersion: 0,
      migrationHistory: [],
      dataStatistics: {
        rubbings: 0,
        damages: 0,
        batches: 0,
        repairImages: 0,
        batchSnapshots: 0
      }
    },
    entities: {
      rubbings: [],
      damages: [],
      batches: [],
      repairImages: [],
      batchSnapshots: []
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

function validateV2Structure(data) {
  const errors = [];
  if (!data || typeof data !== "object") {
    errors.push("根节点不是对象");
    return errors;
  }
  if (data.schemaVersion !== 2) {
    errors.push(`schemaVersion 应为 2，实际为 ${data.schemaVersion}`);
  }
  if (!data.meta || typeof data.meta !== "object") {
    errors.push("缺少 meta 字段");
  } else {
    if (!Array.isArray(data.meta.migrationHistory)) {
      errors.push("meta.migrationHistory 不是数组");
    }
    if (!data.meta.dataStatistics || typeof data.meta.dataStatistics !== "object") {
      errors.push("缺少 meta.dataStatistics");
    }
  }
  if (!data.entities || typeof data.entities !== "object") {
    errors.push("缺少 entities 字段");
  } else {
    const requiredEntityKeys = ["rubbings", "damages", "batches"];
    const optionalEntityKeys = ["repairImages", "batchSnapshots"];
    for (const k of requiredEntityKeys) {
      if (!Array.isArray(data.entities[k])) {
        errors.push(`entities.${k} 不是数组`);
      }
    }
    for (const k of optionalEntityKeys) {
      if (data.entities[k] !== undefined && !Array.isArray(data.entities[k])) {
        errors.push(`entities.${k} 不是数组`);
      }
    }
  }
  if (!data.imageArchive || typeof data.imageArchive !== "object") {
    errors.push("缺少 imageArchive 字段");
  } else {
    if (!Array.isArray(data.imageArchive.archivedImages)) {
      errors.push("imageArchive.archivedImages 不是数组");
    }
    if (!data.imageArchive.archiveStats || typeof data.imageArchive.archiveStats !== "object") {
      errors.push("缺少 imageArchive.archiveStats");
    }
  }
  return errors;
}

function buildV3EmptyStructure() {
  return {
    schemaVersion: 3,
    meta: {
      createdAt: null,
      lastModifiedAt: null,
      writeVersion: 0,
      migrationHistory: [],
      dataStatistics: {
        rubbings: 0,
        damages: 0,
        batches: 0,
        repairImages: 0,
        batchSnapshots: 0,
        auditTrailEvents: 0
      }
    },
    entities: {
      rubbings: [],
      damages: [],
      batches: [],
      repairImages: [],
      batchSnapshots: []
    },
    imageArchive: {
      summary: {
        totalArchived: 0,
        totalByStage: {
          before_repair: 0,
          during_repair: 0,
          after_repair: 0
        },
        byDamageId: {},
        byBatchId: {},
        byMonth: {},
        lastArchivedAt: null,
        firstArchivedAt: null,
        storagePath: "./data/image-archive"
      }
    },
    auditTrail: []
  };
}

function validateV3Structure(data) {
  const errors = [];
  if (!data || typeof data !== "object") {
    errors.push("根节点不是对象");
    return errors;
  }
  if (data.schemaVersion !== 3) {
    errors.push(`schemaVersion 应为 3，实际为 ${data.schemaVersion}`);
  }
  if (!data.meta || typeof data.meta !== "object") {
    errors.push("缺少 meta 字段");
  } else {
    if (!Array.isArray(data.meta.migrationHistory)) {
      errors.push("meta.migrationHistory 不是数组");
    }
    if (!data.meta.dataStatistics || typeof data.meta.dataStatistics !== "object") {
      errors.push("缺少 meta.dataStatistics");
    }
    if (data.meta.dataStatistics.auditTrailEvents === undefined) {
      errors.push("meta.dataStatistics 缺少 auditTrailEvents 统计");
    }
  }
  if (!data.entities || typeof data.entities !== "object") {
    errors.push("缺少 entities 字段");
  } else {
    const entityKeys = ["rubbings", "damages", "batches", "repairImages", "batchSnapshots"];
    for (const k of entityKeys) {
      if (!Array.isArray(data.entities[k])) {
        errors.push(`entities.${k} 不是数组`);
      }
    }
  }
  if (!data.imageArchive || typeof data.imageArchive !== "object") {
    errors.push("缺少 imageArchive 字段");
  } else {
    if (!data.imageArchive.summary || typeof data.imageArchive.summary !== "object") {
      errors.push("缺少 imageArchive.summary");
    } else {
      const summary = data.imageArchive.summary;
      if (typeof summary.totalArchived !== "number") {
        errors.push("imageArchive.summary.totalArchived 不是数字");
      }
      if (!summary.totalByStage || typeof summary.totalByStage !== "object") {
        errors.push("缺少 imageArchive.summary.totalByStage");
      }
      if (!summary.byDamageId || typeof summary.byDamageId !== "object") {
        errors.push("缺少 imageArchive.summary.byDamageId");
      }
      if (!summary.byBatchId || typeof summary.byBatchId !== "object") {
        errors.push("缺少 imageArchive.summary.byBatchId");
      }
      if (!summary.byMonth || typeof summary.byMonth !== "object") {
        errors.push("缺少 imageArchive.summary.byMonth");
      }
    }
  }
  if (!Array.isArray(data.auditTrail)) {
    errors.push("auditTrail 不是数组");
  }
  return errors;
}

async function ensureDirs() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  await mkdir(BACKUP_DIR, { recursive: true });
}

async function readDbRaw() {
  try {
    const content = await readFile(DB_FILE, "utf8");
    return JSON.parse(content);
  } catch (e) {
    const error = new Error(`读取数据库失败: ${e.message}`);
    error.code = "READ_FAILED";
    throw error;
  }
}

async function writeDbRaw(data) {
  const tempFile = path.join(path.dirname(DB_FILE), `.db.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.json`);
  try {
    const jsonStr = JSON.stringify(data, null, 2);
    await writeFile(tempFile, jsonStr);
    JSON.parse(await readFile(tempFile, "utf8"));
    await renameWithFallback(tempFile, DB_FILE);
  } catch (e) {
    try {
      await unlink(tempFile);
    } catch (_) {
    }
    throw e;
  }
}

async function renameWithFallback(src, dest) {
  try {
    await rename(src, dest);
  } catch (renameErr) {
    if (renameErr.code === "EXDEV" || renameErr.code === "EPERM") {
      await copyFile(src, dest);
      await unlink(src);
    } else {
      throw renameErr;
    }
  }
}

async function createMigrationBackup(fromVersion, toVersion) {
  await ensureDirs();
  const rawContent = await readFile(DB_FILE, "utf8");
  let parsedData;
  try {
    parsedData = JSON.parse(rawContent);
  } catch (e) {
    const error = new Error(`数据库 JSON 损坏，无法创建迁移备份: ${e.message}`);
    error.code = "JSON_CORRUPTED";
    throw error;
  }
  const timestamp = formatTimestamp(new Date());
  const filename = getMigrationBackupFilename(timestamp, fromVersion, toVersion);
  const backupPath = path.join(BACKUP_DIR, filename);
  const versionInfo = detectSchemaVersion(parsedData);
  const backupData = {
    meta: {
      type: "migration_backup",
      createdAt: new Date().toISOString(),
      fromVersion,
      toVersion,
      originalVersion: versionInfo.version,
      originalValid: versionInfo.valid,
      dataCounts: {
        rubbings: Array.isArray(parsedData.rubbings) ? parsedData.rubbings.length : (parsedData.entities?.rubbings?.length || 0),
        damages: Array.isArray(parsedData.damages) ? parsedData.damages.length : (parsedData.entities?.damages?.length || 0),
        batches: Array.isArray(parsedData.batches) ? parsedData.batches.length : (parsedData.entities?.batches?.length || 0),
        repairImages: Array.isArray(parsedData.repairImages) ? parsedData.repairImages.length : (parsedData.entities?.repairImages?.length || 0),
        batchSnapshots: Array.isArray(parsedData.batchSnapshots) ? parsedData.batchSnapshots.length : (parsedData.entities?.batchSnapshots?.length || 0)
      }
    },
    data: parsedData
  };
  const tempBackup = path.join(BACKUP_DIR, `.tmp_backup_${Date.now()}.json`);
  try {
    await writeFile(tempBackup, JSON.stringify(backupData, null, 2));
    const verifyContent = JSON.parse(await readFile(tempBackup, "utf8"));
    if (!verifyContent.data || !verifyContent.meta) {
      throw new Error("备份文件结构验证失败");
    }
    await rename(tempBackup, backupPath);
  } catch (e) {
    try {
      await unlink(tempBackup);
    } catch (_) {
    }
    throw e;
  }
  const stats = await stat(backupPath);
  return {
    filename,
    path: backupPath,
    createdAt: backupData.meta.createdAt,
    size: stats.size,
    dataCounts: backupData.meta.dataCounts,
    originalValid: versionInfo.valid
  };
}

async function restoreFromBackupFile(backupPath) {
  const content = JSON.parse(await readFile(backupPath, "utf8"));
  const originalData = content.data || content;
  const tempFile = path.join(path.dirname(DB_FILE), `.db_restore_${Date.now()}.json`);
  try {
    await writeFile(tempFile, JSON.stringify(originalData, null, 2));
    JSON.parse(await readFile(tempFile, "utf8"));
    await renameWithFallback(tempFile, DB_FILE);
  } finally {
    try {
      await unlink(tempFile);
    } catch (_) {
    }
  }
}

function detectPotentialConflicts(oldData, targetVersion) {
  const conflicts = [];
  if (targetVersion >= 2) {
    if (oldData.meta && typeof oldData.meta === "object") {
      conflicts.push({
        level: "warning",
        type: "field_overlap",
        message: "旧数据已包含 meta 字段，迁移时将被覆盖为新结构",
        field: "meta"
      });
    }
    if (oldData.entities && typeof oldData.entities === "object") {
      conflicts.push({
        level: "warning",
        type: "field_overlap",
        message: "旧数据已包含 entities 字段，迁移时将被覆盖",
        field: "entities"
      });
    }
    if (oldData.imageArchive && typeof oldData.imageArchive === "object") {
      conflicts.push({
        level: "warning",
        type: "field_overlap",
        message: "旧数据已包含 imageArchive 字段，迁移时将被覆盖",
        field: "imageArchive"
      });
    }
    if (typeof oldData.schemaVersion !== "undefined") {
      conflicts.push({
        level: "info",
        type: "version_field",
        message: "旧数据已有 schemaVersion 字段",
        field: "schemaVersion"
      });
    }
  }
  const rubbings = oldData.rubbings || oldData.entities?.rubbings || [];
  const damages = oldData.damages || oldData.entities?.damages || [];
  const rubbingIds = new Set(rubbings.map((r) => r.id));
  for (const d of damages) {
    if (d.rubbingId && !rubbingIds.has(d.rubbingId)) {
      conflicts.push({
        level: "warning",
        type: "orphan_reference",
        message: `缺损 ${d.id} 引用了不存在的拓片 ${d.rubbingId}`,
        field: `damages[${d.id}].rubbingId`
      });
    }
  }
  return conflicts;
}

function migrateV0ToV1(oldData) {
  return {
    schemaVersion: 1,
    rubbings: oldData.rubbings || [],
    damages: oldData.damages || [],
    batches: oldData.batches || [],
    repairImages: oldData.repairImages || [],
    batchSnapshots: oldData.batchSnapshots || []
  };
}

function migrateV1ToV2(oldData, migrationMeta) {
  const now = new Date().toISOString();
  const newStructure = buildV2EmptyStructure();
  newStructure.schemaVersion = 2;
  newStructure.meta = {
    createdAt: now,
    lastModifiedAt: now,
    migrationHistory: [
      {
        fromVersion: migrationMeta.fromVersion,
        toVersion: 2,
        migratedAt: now,
        backupFile: migrationMeta.backupFile || null,
        note: migrationMeta.note || "自动迁移"
      }
    ],
    dataStatistics: {
      rubbings: (oldData.rubbings || []).length,
      damages: (oldData.damages || []).length,
      batches: (oldData.batches || []).length,
      repairImages: (oldData.repairImages || []).length,
      batchSnapshots: (oldData.batchSnapshots || []).length
    }
  };
  newStructure.entities = {
    rubbings: oldData.rubbings || [],
    damages: oldData.damages || [],
    batches: oldData.batches || [],
    repairImages: oldData.repairImages || [],
    batchSnapshots: oldData.batchSnapshots || []
  };
  return newStructure;
}

function rebuildImageArchiveStats(entities) {
  const repairImages = entities.repairImages || [];
  const damages = entities.damages || [];
  const damageBatchMap = new Map();
  damages.forEach((d) => {
    if (d.batchId) {
      damageBatchMap.set(d.id, d.batchId);
    }
  });

  const summary = {
    totalArchived: repairImages.length,
    totalByStage: {
      before_repair: 0,
      during_repair: 0,
      after_repair: 0
    },
    byDamageId: {},
    byBatchId: {},
    byMonth: {},
    lastArchivedAt: null,
    firstArchivedAt: null,
    storagePath: "./data/image-archive"
  };

  let earliest = null;
  let latest = null;

  repairImages.forEach((img) => {
    if (img.stage && summary.totalByStage[img.stage] !== undefined) {
      summary.totalByStage[img.stage] += 1;
    }

    if (img.damageId) {
      if (!summary.byDamageId[img.damageId]) {
        summary.byDamageId[img.damageId] = {
          total: 0,
          byStage: { before_repair: 0, during_repair: 0, after_repair: 0 }
        };
      }
      summary.byDamageId[img.damageId].total += 1;
      if (img.stage && summary.byDamageId[img.damageId].byStage[img.stage] !== undefined) {
        summary.byDamageId[img.damageId].byStage[img.stage] += 1;
      }

      const batchId = damageBatchMap.get(img.damageId);
      if (batchId) {
        if (!summary.byBatchId[batchId]) {
          summary.byBatchId[batchId] = {
            total: 0,
            byStage: { before_repair: 0, during_repair: 0, after_repair: 0 }
          };
        }
        summary.byBatchId[batchId].total += 1;
        if (img.stage && summary.byBatchId[batchId].byStage[img.stage] !== undefined) {
          summary.byBatchId[batchId].byStage[img.stage] += 1;
        }
      }
    }

    const createdAt = img.createdAt || img.capturedAt;
    if (createdAt) {
      const d = new Date(createdAt);
      if (!isNaN(d.getTime())) {
        const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (!summary.byMonth[monthKey]) {
          summary.byMonth[monthKey] = 0;
        }
        summary.byMonth[monthKey] += 1;

        if (!earliest || d < earliest) earliest = d;
        if (!latest || d > latest) latest = d;
      }
    }
  });

  summary.firstArchivedAt = earliest ? earliest.toISOString() : null;
  summary.lastArchivedAt = latest ? latest.toISOString() : null;

  return summary;
}

async function rebuildAuditTrailFromAuditLog() {
  try {
    const content = await readFile(AUDIT_LOG_FILE, "utf8");
    const auditLogs = JSON.parse(content);
    if (!Array.isArray(auditLogs)) return [];

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

    return auditLogs.map((log) => ({
      id: log.id || `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      eventType: eventTypeMap[log.actionType] || log.actionType || "unknown_event",
      targetType: log.targetType || null,
      targetId: log.targetId || null,
      timestamp: log.timestamp || new Date().toISOString(),
      actor: (log.newValues && log.newValues.reviewedBy) || (log.extra && log.extra.actor) || null,
      oldValues: log.oldValues || null,
      newValues: log.newValues || null,
      reason: (log.newValues && log.newValues.rejectReason) || (log.extra && log.extra.reason) || null,
      metadata: {
        changeSummary: log.changeSummary || null,
        success: log.success !== undefined ? log.success : true,
        extra: log.extra || null
      }
    }));
  } catch (e) {
    console.warn(`[migrator] 从 audit-logs.json 重建 auditTrail 失败: ${e.message}`);
    return [];
  }
}

function buildDamageAuditTrailFromEntities(entities) {
  const events = [];
  const damages = entities.damages || [];
  const now = new Date().toISOString();

  damages.forEach((damage) => {
    if (damage.reviewStatus === "approved" && damage.reviewedAt) {
      events.push({
        id: `evt_dmg_${damage.id}_approve`,
        eventType: "damage_approved",
        targetType: "damage",
        targetId: damage.id,
        timestamp: damage.reviewedAt,
        actor: damage.reviewedBy || null,
        oldValues: { reviewStatus: "review_pending" },
        newValues: { reviewStatus: "approved", reviewedBy: damage.reviewedBy, reviewedAt: damage.reviewedAt },
        reason: null,
        metadata: { success: true, source: "v2_entity_migration" }
      });
    }
    if (damage.reviewStatus === "rejected" && damage.reviewedAt) {
      events.push({
        id: `evt_dmg_${damage.id}_reject`,
        eventType: "damage_rejected",
        targetType: "damage",
        targetId: damage.id,
        timestamp: damage.reviewedAt,
        actor: damage.reviewedBy || null,
        oldValues: { reviewStatus: "review_pending" },
        newValues: { reviewStatus: "rejected", reviewedBy: damage.reviewedBy, reviewedAt: damage.reviewedAt, rejectReason: damage.rejectReason },
        reason: damage.rejectReason || null,
        metadata: { success: true, source: "v2_entity_migration" }
      });
    }
    if (damage.status === "repaired" && damage.repairedAt) {
      events.push({
        id: `evt_dmg_${damage.id}_repaired`,
        eventType: "damage_status_changed",
        targetType: "damage",
        targetId: damage.id,
        timestamp: damage.repairedAt,
        actor: null,
        oldValues: { status: "in_repair" },
        newValues: { status: "repaired", repairedAt: damage.repairedAt, repairNote: damage.repairNote, afterPhotoUrl: damage.afterPhotoUrl },
        reason: null,
        metadata: { success: true, source: "v2_entity_migration" }
      });
    }
  });

  const batches = entities.batches || [];
  batches.forEach((batch) => {
    if (batch.status === "completed" && batch.completedAt) {
      events.push({
        id: `evt_batch_${batch.id}_complete`,
        eventType: "batch_completed",
        targetType: "batch",
        targetId: batch.id,
        timestamp: batch.completedAt,
        actor: batch.responsible || null,
        oldValues: { status: "open" },
        newValues: { status: "completed", completedAt: batch.completedAt, note: batch.note },
        reason: null,
        metadata: { success: true, source: "v2_entity_migration", damageCount: batch.damageIds.length }
      });
    }
    if (batch.status === "partially_rolled_back") {
      events.push({
        id: `evt_batch_${batch.id}_partial_rollback`,
        eventType: "batch_partially_rolled_back",
        targetType: "batch",
        targetId: batch.id,
        timestamp: batch.completedAt || now,
        actor: batch.responsible || null,
        oldValues: { status: "completed" },
        newValues: { status: "partially_rolled_back", rolledBackDamageIds: batch.rolledBackDamageIds || [] },
        reason: null,
        metadata: { success: true, source: "v2_entity_migration", rolledBackCount: (batch.rolledBackDamageIds || []).length }
      });
    }
  });

  return events;
}

async function migrateV2ToV3(oldData, migrationMeta) {
  const now = new Date().toISOString();
  const newStructure = buildV3EmptyStructure();
  newStructure.schemaVersion = 3;

  const sourceEntities = oldData.entities || oldData;
  const entities = {
    rubbings: sourceEntities.rubbings || [],
    damages: sourceEntities.damages || [],
    batches: sourceEntities.batches || [],
    repairImages: sourceEntities.repairImages || [],
    batchSnapshots: sourceEntities.batchSnapshots || []
  };

  const oldMigrationHistory = oldData.meta && Array.isArray(oldData.meta.migrationHistory)
    ? oldData.meta.migrationHistory
    : [];

  newStructure.meta = {
    createdAt: oldData.meta?.createdAt || now,
    lastModifiedAt: now,
    migrationHistory: [
      ...oldMigrationHistory,
      {
        fromVersion: migrationMeta.fromVersion,
        toVersion: 3,
        migratedAt: now,
        backupFile: migrationMeta.backupFile || null,
        note: migrationMeta.note || "v2→v3 升级：新增 auditTrail 历史事件、增强 imageArchive 统计"
      }
    ],
    dataStatistics: {
      rubbings: entities.rubbings.length,
      damages: entities.damages.length,
      batches: entities.batches.length,
      repairImages: entities.repairImages.length,
      batchSnapshots: entities.batchSnapshots.length,
      auditTrailEvents: 0
    }
  };

  newStructure.entities = entities;

  newStructure.imageArchive.summary = rebuildImageArchiveStats(entities);

  const entityEvents = buildDamageAuditTrailFromEntities(entities);
  const auditLogEvents = await rebuildAuditTrailFromAuditLog();

  const eventIdMap = new Map();
  const allEvents = [...entityEvents, ...auditLogEvents];
  const uniqueEvents = [];
  allEvents.forEach((evt) => {
    if (!eventIdMap.has(evt.id)) {
      eventIdMap.set(evt.id, true);
      uniqueEvents.push(evt);
    }
  });

  uniqueEvents.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  newStructure.auditTrail = uniqueEvents;
  newStructure.meta.dataStatistics.auditTrailEvents = uniqueEvents.length;

  return newStructure;
}

async function migrateToLatest() {
  await ensureDirs();

  let dbExists = true;
  try {
    await stat(DB_FILE);
  } catch (_) {
    dbExists = false;
  }

  if (!dbExists) {
    const emptyV3 = buildV3EmptyStructure();
    const now = new Date().toISOString();
    emptyV3.meta.createdAt = now;
    emptyV3.meta.lastModifiedAt = now;
    await writeDbRaw(emptyV3);
    return {
      success: true,
      action: "initialized",
      fromVersion: null,
      toVersion: CURRENT_SCHEMA_VERSION,
      message: "数据库不存在，已初始化为最新版本结构",
      backup: null
    };
  }

  let currentData;
  try {
    currentData = await readDbRaw();
  } catch (readError) {
    const error = new Error(`读取数据库失败，无法执行迁移: ${readError.message}`);
    error.code = "READ_FAILED";
    error.cause = readError;
    throw error;
  }

  const versionInfo = detectSchemaVersion(currentData);
  if (!versionInfo.valid) {
    let backup = null;
    try {
      backup = await createMigrationBackup(versionInfo.version !== null ? versionInfo.version : "unknown", CURRENT_SCHEMA_VERSION);
    } catch (_) {
    }
    let errorCode = "INVALID_STRUCTURE";
    if (versionInfo.version !== null && versionInfo.version === CURRENT_SCHEMA_VERSION) {
      errorCode = "V2_STRUCTURE_CORRUPTED";
    } else if (versionInfo.version !== null) {
      errorCode = `V${versionInfo.version}_STRUCTURE_CORRUPTED`;
    }
    const error = new Error(`数据结构无效: ${versionInfo.reason}`);
    error.code = errorCode;
    error.backupFile = backup?.filename || null;
    error.detectedVersion = versionInfo.version;
    throw error;
  }

  if (versionInfo.version === CURRENT_SCHEMA_VERSION) {
    const validationErrors = validateV3Structure(currentData);
    if (validationErrors.length > 0) {
      const error = new Error(`v3 结构校验失败: ${validationErrors.join("; ")}`);
      error.code = "V3_STRUCTURE_CORRUPTED";
      error.validationErrors = validationErrors;
      throw error;
    }
    return {
      success: true,
      action: "none",
      fromVersion: CURRENT_SCHEMA_VERSION,
      toVersion: CURRENT_SCHEMA_VERSION,
      message: "数据已是最新版本，无需迁移",
      backup: null
    };
  }

  if (versionInfo.version < MIN_SUPPORTED_VERSION) {
    const error = new Error(`数据版本 v${versionInfo.version} 低于最低支持版本 v${MIN_SUPPORTED_VERSION}，无法迁移`);
    error.code = "UNSUPPORTED_VERSION";
    throw error;
  }

  const conflicts = detectPotentialConflicts(currentData, CURRENT_SCHEMA_VERSION);

  let backup;
  try {
    backup = await createMigrationBackup(versionInfo.version, CURRENT_SCHEMA_VERSION);
  } catch (backupErr) {
    const error = new Error(`创建迁移备份失败，已中止迁移: ${backupErr.message}`);
    error.code = "BACKUP_CREATION_FAILED";
    error.cause = backupErr;
    throw error;
  }

  let workingData = currentData;
  let migrationSteps = [];
  let migrated = false;

  try {
    if (versionInfo.version === 0) {
      workingData = migrateV0ToV1(workingData);
      migrationSteps.push("v0→v1");
    }
    if (workingData.schemaVersion === 1) {
      workingData = migrateV1ToV2(workingData, {
        fromVersion: versionInfo.version,
        backupFile: backup.filename,
        note: migrationSteps.length > 0 ? `经 ${migrationSteps.join(", ")} 升级` : "直接升级"
      });
      migrationSteps.push("v1→v2");
    }
    if (workingData.schemaVersion === 2) {
      workingData = await migrateV2ToV3(workingData, {
        fromVersion: versionInfo.version,
        backupFile: backup.filename,
        note: migrationSteps.length > 0 ? `经 ${migrationSteps.join(", ")} 升级` : "直接升级"
      });
      migrationSteps.push("v2→v3");
    }

    const validationErrors = validateV3Structure(workingData);
    if (validationErrors.length > 0) {
      throw new Error(`迁移后结构校验失败: ${validationErrors.join("; ")}`);
    }

    const originalWriteVersion = currentData?.meta?.writeVersion ?? 0;
    if (workingData.meta) {
      workingData.meta.writeVersion = originalWriteVersion + 1;
    }

    await writeDbRaw(workingData);
    migrated = true;

    let verifyData;
    try {
      verifyData = await readDbRaw();
    } catch (verifyReadErr) {
      throw new Error(`写回后读取失败: ${verifyReadErr.message}`);
    }

    const verifyErrors = validateV3Structure(verifyData);
    if (verifyErrors.length > 0) {
      throw new Error(`写回后结构校验失败: ${verifyErrors.join("; ")}`);
    }
    if (verifyData.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      throw new Error(`写回后版本号异常: 期望 v${CURRENT_SCHEMA_VERSION}, 实际 v${verifyData.schemaVersion}`);
    }

    return {
      success: true,
      action: "migrated",
      fromVersion: versionInfo.version,
      toVersion: CURRENT_SCHEMA_VERSION,
      message: `迁移成功: ${migrationSteps.join(", ")}`,
      backup,
      conflicts,
      steps: migrationSteps
    };
  } catch (migrationError) {
    if (migrated) {
      try {
        await restoreFromBackupFile(backup.path);
      } catch (restoreError) {
        const fatalError = new Error(
          `迁移失败且回滚失败！原数据可能已损坏。请手动从备份文件恢复: ${backup.path}。迁移错误: ${migrationError.message}；回滚错误: ${restoreError.message}`
        );
        fatalError.code = "MIGRATION_AND_ROLLBACK_FAILED";
        fatalError.backupFile = backup.filename;
        fatalError.backupPath = backup.path;
        fatalError.migrationError = migrationError.message;
        fatalError.restoreError = restoreError.message;
        throw fatalError;
      }
    }
    const error = new Error(`迁移失败${migrated ? "，已回滚到原版本" : "，数据未被修改"}。错误: ${migrationError.message}`);
    error.code = migrated ? "MIGRATION_FAILED_ROLLED_BACK" : "MIGRATION_FAILED_NO_CHANGE";
    error.backupFile = backup.filename;
    error.backupPath = backup.path;
    error.cause = migrationError;
    throw error;
  }
}

async function checkMigrationStatus() {
  await ensureDirs();
  const result = {
    dbExists: false,
    currentVersion: null,
    latestVersion: CURRENT_SCHEMA_VERSION,
    needsMigration: false,
    structureValid: false,
    validationErrors: [],
    migrationPath: [],
    potentialConflicts: [],
    backups: []
  };
  try {
    await stat(DB_FILE);
    result.dbExists = true;
  } catch (_) {
    result.dbExists = false;
    result.needsMigration = true;
    result.migrationPath = ["(初始化) -> v" + CURRENT_SCHEMA_VERSION];
    return result;
  }
  let rawData;
  try {
    rawData = await readDbRaw();
  } catch (e) {
    result.structureValid = false;
    result.validationErrors.push(`JSON 解析失败: ${e.message}`);
    return result;
  }
  const versionInfo = detectSchemaVersion(rawData);
  result.currentVersion = versionInfo.version;
  result.structureValid = versionInfo.valid;
  if (!versionInfo.valid) {
    result.validationErrors.push(versionInfo.reason || "未知结构错误");
    return result;
  }
  if (versionInfo.version === CURRENT_SCHEMA_VERSION) {
    result.validationErrors = validateV3Structure(rawData);
    result.structureValid = result.validationErrors.length === 0;
  }
  result.needsMigration = versionInfo.version < CURRENT_SCHEMA_VERSION;
  if (result.needsMigration) {
    if (versionInfo.version === 0) {
      result.migrationPath.push("v0 (扁平) -> v1");
      result.migrationPath.push("v1 -> v2");
      result.migrationPath.push("v2 -> v3");
    } else if (versionInfo.version === 1) {
      result.migrationPath.push("v1 -> v2");
      result.migrationPath.push("v2 -> v3");
    } else if (versionInfo.version === 2) {
      result.migrationPath.push("v2 -> v3");
    }
    result.potentialConflicts = detectPotentialConflicts(rawData, CURRENT_SCHEMA_VERSION);
  }
  try {
    const files = await readdir(BACKUP_DIR);
    const migrationBackups = files.filter(isMigrationBackup).sort().reverse();
    for (const filename of migrationBackups.slice(0, 10)) {
      try {
        const filePath = path.join(BACKUP_DIR, filename);
        const stats = await stat(filePath);
        const content = JSON.parse(await readFile(filePath, "utf8"));
        result.backups.push({
          filename,
          createdAt: content.meta?.createdAt || stats.mtime.toISOString(),
          fromVersion: content.meta?.fromVersion,
          toVersion: content.meta?.toVersion,
          size: stats.size,
          dataCounts: content.meta?.dataCounts || null
        });
      } catch (_) {
      }
    }
  } catch (_) {
  }
  return result;
}

async function runCli() {
  const args = process.argv.slice(2);
  const command = args[0] || "status";

  if (command === "--help" || command === "-h") {
    console.log(`
数据迁移工具 - 使用方法:
  node data-migrator.js status    显示当前数据版本和迁移状态 (默认)
  node data-migrator.js migrate   执行数据迁移到最新版本
  node data-migrator.js check     详细检查数据结构和潜在冲突
  node data-migrator.js --help    显示此帮助
`);
    return 0;
  }

  if (command === "status") {
    try {
      const status = await checkMigrationStatus();
      console.log("=== 数据迁移状态 ===");
      console.log(`数据库文件: ${DB_FILE}`);
      console.log(`数据库存在: ${status.dbExists ? "是" : "否"}`);
      console.log(`当前版本: ${status.currentVersion !== null ? "v" + status.currentVersion : "未知"}`);
      console.log(`最新版本: v${status.latestVersion}`);
      console.log(`需要迁移: ${status.needsMigration ? "是" : "否"}`);
      console.log(`结构有效: ${status.structureValid ? "是" : "否"}`);
      if (status.validationErrors.length > 0) {
        console.log("\n结构错误:");
        status.validationErrors.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
      }
      if (status.migrationPath.length > 0) {
        console.log("\n迁移路径:");
        status.migrationPath.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
      }
      if (status.potentialConflicts.length > 0) {
        console.log(`\n潜在冲突 (${status.potentialConflicts.length} 项):`);
        status.potentialConflicts.forEach((c, i) => {
          console.log(`  ${i + 1}. [${c.level.toUpperCase()}] ${c.message}`);
        });
      }
      if (status.backups.length > 0) {
        console.log(`\n最近迁移备份 (${status.backups.length} 个):`);
        status.backups.forEach((b) => {
          console.log(`  - ${b.filename} (${b.createdAt}, ${b.size} bytes)`);
        });
      }
      return status.needsMigration ? 1 : 0;
    } catch (e) {
      console.error(`状态检查失败: ${e.message}`);
      return 2;
    }
  }

  if (command === "check") {
    try {
      const status = await checkMigrationStatus();
      console.log(JSON.stringify(status, null, 2));
      return 0;
    } catch (e) {
      console.error(JSON.stringify({ error: e.message, code: e.code }, null, 2));
      return 2;
    }
  }

  if (command === "migrate") {
    try {
      const result = await migrateToLatest();
      console.log("=== 迁移结果 ===");
      console.log(`成功: ${result.success ? "是" : "否"}`);
      console.log(`操作: ${result.action}`);
      console.log(`从版本: ${result.fromVersion !== null ? "v" + result.fromVersion : "(空)"}`);
      console.log(`到版本: v${result.toVersion}`);
      console.log(`消息: ${result.message}`);
      if (result.backup) {
        console.log(`\n备份文件: ${result.backup.filename}`);
        console.log(`备份路径: ${result.backup.path}`);
      }
      if (result.conflicts && result.conflicts.length > 0) {
        console.log(`\n迁移时发现的潜在冲突 (${result.conflicts.length} 项):`);
        result.conflicts.forEach((c, i) => {
          console.log(`  ${i + 1}. [${c.level.toUpperCase()}] ${c.message}`);
        });
      }
      if (result.steps && result.steps.length > 0) {
        console.log(`\n执行步骤: ${result.steps.join(" -> ")}`);
      }
      return result.success ? 0 : 1;
    } catch (e) {
      console.error(`迁移失败: ${e.message}`);
      if (e.backupFile) {
        console.error(`备份文件: ${e.backupFile}`);
      }
      if (e.code) {
        console.error(`错误代码: ${e.code}`);
      }
      return 3;
    }
  }

  console.error(`未知命令: ${command}`);
  console.error("使用 --help 查看帮助");
  return 2;
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  MIN_SUPPORTED_VERSION,
  detectSchemaVersion,
  validateV2Structure,
  validateV3Structure,
  buildV2EmptyStructure,
  buildV3EmptyStructure,
  rebuildImageArchiveStats,
  migrateToLatest,
  checkMigrationStatus,
  createMigrationBackup,
  detectPotentialConflicts,
  runCli
};

if (require.main === module) {
  (async () => {
    const code = await runCli();
    process.exit(code);
  })();
}
