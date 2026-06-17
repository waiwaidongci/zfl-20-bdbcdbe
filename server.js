const http = require("http");
const { readFile, writeFile, mkdir, readdir, stat, unlink } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3020);
const DB_FILE = path.join(__dirname, "data", "db.json");
const AUDIT_LOG_FILE = path.join(__dirname, "data", "audit-logs.json");
const BACKUP_DIR = path.join(__dirname, "data", "backups");

const AUDIT_ACTION_TYPES = {
  CREATE_RUBBING: "create_rubbing",
  REGISTER_DAMAGE: "register_damage",
  UPDATE_DAMAGE: "update_damage",
  CREATE_BATCH: "create_batch",
  COMPLETE_BATCH: "complete_batch",
  ROLLBACK_BATCH: "rollback_batch"
};

const BACKUP_ERRORS = {
  BACKUP_NOT_FOUND: "BACKUP_NOT_FOUND",
  JSON_CORRUPTED: "JSON_CORRUPTED",
  INVALID_STRUCTURE: "INVALID_STRUCTURE"
};

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
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete",
  "POST /batches/:id/rollback",
  "POST /import/precheck",
  "POST /import/confirm",
  "GET /dashboard/repair-workbench?type=&rubbingId=&batchId=",
  "GET /rubbings/:id/summary",
  "GET /schedules?startDate=&endDate=&status=",
  "GET /export/rubbings?startDate=&endDate=",
  "GET /export/damages?status=&type=&startDate=&endDate=",
  "GET /export/batches?status=&startDate=&endDate=",
  "GET /export/repair-results?status=&type=&startDate=&endDate=",
  "GET /backups",
  "POST /backups",
  "GET /backups/:filename/validate",
  "POST /backups/:filename/restore",
  "GET /audit-logs?actionType=&targetId="
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const data = JSON.parse(await readFile(DB_FILE, "utf8"));
  if (!data.repairImages) data.repairImages = [];
  if (!data.batchSnapshots) data.batchSnapshots = [];
  return data;
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
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

function buildChangeSummary(actionType, oldValues, newValues) {
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
    case AUDIT_ACTION_TYPES.CREATE_BATCH:
      return `创建批次：${newValues.name}，包含 ${newValues.damageIds.length} 项缺损`;
    case AUDIT_ACTION_TYPES.COMPLETE_BATCH:
      return `完成批次：${newValues.name}，共完成 ${newValues.damageIds.length} 项缺损修补`;
    case AUDIT_ACTION_TYPES.ROLLBACK_BATCH:
      return `回滚批次：${oldValues.name}，恢复 ${oldValues.damageIds.length} 项缺损状态`;
    default:
      return `${actionType}: target ${newValues?.id || "unknown"}`;
  }
}

async function executeWithAudit({ actionType, targetType, targetId, oldValues, newValues, businessResult, statusCode, res }) {
  try {
    const changeSummary = buildChangeSummary(actionType, oldValues, newValues);
    await writeAuditEntry({
      actionType,
      targetType,
      targetId,
      changeSummary,
      oldValues: oldValues || null,
      newValues: newValues || null
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

function queryAuditLogs(logs, { actionType, targetId } = {}) {
  return logs.filter((entry) => {
    if (actionType && entry.actionType !== actionType) return false;
    if (targetId && entry.targetId !== targetId) return false;
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
  const requiredKeys = ["rubbings", "damages", "batches", "repairImages", "batchSnapshots"];
  for (const key of requiredKeys) {
    if (!Array.isArray(data[key])) return false;
  }
  return true;
}

function sanitizeBackupFilename(filename) {
  if (!filename || typeof filename !== "string") {
    const error = new Error("备份文件名无效");
    error.code = BACKUP_ERRORS.BACKUP_NOT_FOUND;
    error.status = 400;
    throw error;
  }
  const SAFE_PATTERN = /^backup_\d{8}_\d{6,9}[_a-z0-9]*\.json$/;
  if (!SAFE_PATTERN.test(filename)) {
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
  const backupData = {
    meta: {
      createdAt: new Date().toISOString(),
      version: 1,
      dataCounts: {
        rubbings: parsedData.rubbings.length,
        damages: parsedData.damages.length,
        batches: parsedData.batches.length,
        repairImages: parsedData.repairImages.length
      }
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
  const backupFiles = files.filter((f) => f.startsWith("backup_") && f.endsWith(".json"));
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
    dataCounts: backup.meta?.dataCounts || {
      rubbings: backup.data.rubbings.length,
      damages: backup.data.damages.length,
      batches: backup.data.batches.length,
      repairImages: backup.data.repairImages.length
    },
    size: stats.size
  };
}

async function restoreFromBackup(filename) {
  const validation = await validateBackup(filename);
  const backup = await readBackupFile(filename);
  const tempFile = path.join(BACKUP_DIR, `temp_restore_${Date.now()}.json`);
  try {
    await writeFile(tempFile, JSON.stringify(backup.data, null, 2));
    const verifyData = JSON.parse(await readFile(tempFile, "utf8"));
    if (!validateDataStructure(verifyData)) {
      throw new Error("恢复前校验失败：数据结构无效");
    }
    await writeFile(DB_FILE, JSON.stringify(backup.data, null, 2));
    return {
      success: true,
      restoredFrom: filename,
      restoredAt: new Date().toISOString(),
      dataCounts: validation.dataCounts
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
    reviewStatus: damage.reviewStatus || "approved",
    rejectReason: damage.rejectReason || ""
  };
}

const VALID_STAGES = ["before_repair", "during_repair", "after_repair"];

function groupImagesByStage(images) {
  const grouped = { before_repair: [], during_repair: [], after_repair: [] };
  images.forEach((img) => {
    if (grouped[img.stage]) {
      grouped[img.stage].push(img);
    }
  });
  return grouped;
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
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id)).map(normalizeDamage);
  return {
    ...batch,
    plannedStartAt: batch.plannedStartAt || null,
    plannedEndAt: batch.plannedEndAt || null,
    responsible: batch.responsible || null,
    damages,
    total: damages.length,
    repaired: damages.filter((item) => item.status === "repaired").length,
    pending: damages.filter((item) => item.status !== "repaired").length
  };
}

function computeRepairWorkbenchDashboard(db, filters = {}) {
  const { type, rubbingId, batchId } = filters;

  const filteredDamages = db.damages.filter((damage) => {
    if (type && damage.type !== type) return false;
    if (rubbingId && damage.rubbingId !== rubbingId) return false;
    if (batchId && damage.batchId !== batchId) return false;
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

  const activeBatches = db.batches.filter((b) => {
    if (batchId) return b.id === batchId;
    if (rubbingId) return b.damageIds.some((did) => db.damages.find((d) => d.id === did && d.rubbingId === rubbingId));
    return true;
  });

  return {
    statusCounts,
    byType,
    totalTypes: byType.length,
    activeBatches: activeBatches.filter((b) => b.status === "open").length,
    completedBatches: activeBatches.filter((b) => b.status === "completed").length
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

function getStatusText(status) {
  const statusMap = {
    pending: "待修补",
    in_repair: "修补中",
    repaired: "已修补",
    open: "进行中",
    completed: "已完成",
    approved: "已通过",
    rejected: "已驳回",
    review_pending: "待审核"
  };
  return statusMap[status] || status || "";
}

function exportRubbingsCsv(db, filters = {}) {
  const { startDate, endDate } = filters;
  const start = parseDateRange(startDate);
  const end = parseDateRange(endDate, true);

  let rubbings = filterByDateRange(db.rubbings, start, end);

  const headers = [
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
  const { status, type, startDate, endDate } = filters;
  const start = parseDateRange(startDate);
  const end = parseDateRange(endDate, true);

  let damages = db.damages.filter((d) => {
    if (status && d.status !== status) return false;
    if (type && d.type !== type) return false;
    return true;
  });
  damages = filterByDateRange(damages, start, end);

  const rubbingMap = new Map(db.rubbings.map((r) => [r.id, r]));
  const batchMap = new Map(db.batches.map((b) => [b.id, b]));

  const headers = [
    { key: "id", label: "缺损ID" },
    { key: "rubbingCode", label: "拓片编号" },
    { key: "rubbingSource", label: "拓片来源" },
    { key: "position", label: "缺损位置" },
    { key: "type", label: "缺损类型" },
    { key: "statusText", label: "修补状态" },
    { key: "reviewStatusText", label: "审核状态" },
    { key: "batchName", label: "所属批次" },
    { key: "repairNote", label: "修补说明" },
    { key: "rejectReason", label: "驳回原因" },
    { key: "beforePhotoUrl", label: "修补前照片" },
    { key: "afterPhotoUrl", label: "修补后照片" },
    { key: "createdAt", label: "创建时间" },
    { key: "repairedAt", label: "修补完成时间" }
  ];

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
  const { status, startDate, endDate } = filters;
  const start = parseDateRange(startDate);
  const end = parseDateRange(endDate, true);

  let batches = db.batches.filter((b) => {
    if (status && b.status !== status) return false;
    return true;
  });
  batches = filterByDateRange(batches, start, end);

  const headers = [
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
  const { status, type, startDate, endDate } = filters;
  const start = parseDateRange(startDate);
  const end = parseDateRange(endDate, true);

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
    if (!imagesMap.has(img.damageId)) {
      imagesMap.set(img.damageId, { before_repair: [], during_repair: [], after_repair: [] });
    }
    if (imagesMap.get(img.damageId)[img.stage]) {
      imagesMap.get(img.damageId)[img.stage].push(img);
    }
  });

  const headers = [
    { key: "id", label: "缺损ID" },
    { key: "rubbingCode", label: "拓片编号" },
    { key: "rubbingSource", label: "拓片来源" },
    { key: "position", label: "缺损位置" },
    { key: "type", label: "缺损类型" },
    { key: "statusText", label: "修补状态" },
    { key: "batchName", label: "所属批次" },
    { key: "repairNote", label: "修补说明" },
    { key: "beforeImageCount", label: "修补前影像数" },
    { key: "duringImageCount", label: "修补中影像数" },
    { key: "afterImageCount", label: "修补后影像数" },
    { key: "beforePhotoUrl", label: "修补前照片" },
    { key: "afterPhotoUrl", label: "修补后照片" },
    { key: "createdAt", label: "创建时间" },
    { key: "repairedAt", label: "修补完成时间" }
  ];

  const rows = damages.map((damage) => {
    const rubbing = rubbingMap.get(damage.rubbingId) || {};
    const batch = damage.batchId ? batchMap.get(damage.batchId) : null;
    const images = imagesMap.get(damage.id) || { before_repair: [], during_repair: [], after_repair: [] };
    return {
      id: damage.id,
      rubbingCode: rubbing.code || "",
      rubbingSource: rubbing.source || "",
      position: damage.position,
      type: damage.type,
      statusText: getStatusText(damage.status),
      batchName: batch ? batch.name : "",
      repairNote: damage.repairNote || "",
      beforeImageCount: images.before_repair.length,
      duringImageCount: images.during_repair.length,
      afterImageCount: images.after_repair.length,
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
      status: body.status ?? damage.status,
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
    damage.reviewStatus = "approved";
    damage.rejectReason = "";
    await writeDb(db);
    return send(res, 200, { data: normalizeDamage(damage) });
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
    damage.reviewStatus = "rejected";
    damage.rejectReason = body.reason.trim();
    await writeDb(db);
    return send(res, 200, { data: normalizeDamage(damage) });
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

      const created = [];
      imagesInput.forEach((entry) => {
        const record = {
          id: makeId("img"),
          damageId,
          stage: entry.stage,
          url: entry.url.trim(),
          capturedAt: entry.capturedAt || new Date().toISOString(),
          description: entry.description || "",
          collector: entry.collector || "",
          createdAt: new Date().toISOString()
        };
        db.repairImages.push(record);
        created.push(record);
      });

      await writeDb(db);
      return send(res, 201, { data: created });
    }
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
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
    db.batches.forEach((b) => {
      if (b.status !== "completed") {
        b.damageIds.forEach((did) => scheduledDamageIds.add(did));
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
          createdAt: new Date().toISOString()
        };
        addedImageIds.push(record.id);
        db.repairImages.push(record);
      });
    }

    const existingSnapshotIdx = db.batchSnapshots.findIndex((s) => s.batchId === batch.id);
    let snapshot;
    if (existingSnapshotIdx >= 0) {
      const existing = db.batchSnapshots[existingSnapshotIdx];
      snapshot = {
        ...existing,
        id: makeId("snap"),
        createdAt: new Date().toISOString(),
        addedImageIds: [...(existing.addedImageIds || []), ...addedImageIds]
      };
      db.batchSnapshots[existingSnapshotIdx] = snapshot;
    } else {
      snapshot = {
        id: makeId("snap"),
        batchId: batch.id,
        createdAt: new Date().toISOString(),
        batchBefore: JSON.parse(JSON.stringify(batch)),
        damagesBefore: batchDamageSnapshots,
        addedImageIds
      };
      db.batchSnapshots.push(snapshot);
    }

    batch.status = "completed";
    batch.completedAt = new Date().toISOString();
    batch.note = body.note ?? batch.note;
    db.damages.forEach((damage) => {
      if (!batch.damageIds.includes(damage.id)) return;
      const result = results.find((item) => item.damageId === damage.id) || {};
      damage.status = "repaired";
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

    const snapshot = db.batchSnapshots.find((s) => s.batchId === batchId);
    if (!snapshot) {
      return send(res, 400, {
        error: `无法回滚批次 ${batch.name}：未找到完成时的快照数据。该批次可能是在回滚功能上线前完成的旧数据，不支持回滚操作。如需恢复请联系管理员通过备份还原。`,
        code: "SNAPSHOT_NOT_FOUND",
        hint: "旧批次数据无快照，仅支持功能上线后新完成的批次回滚"
      });
    }

    const batchCompletedAt = batch.completedAt ? new Date(batch.completedAt) : null;
    const referencedBy = [];
    db.batches.forEach((other) => {
      if (other.id === batchId) return;
      const otherCompletedAt = other.completedAt ? new Date(other.completedAt) : null;
      if (!otherCompletedAt || !batchCompletedAt) return;
      if (otherCompletedAt <= batchCompletedAt) return;
      const overlap = other.damageIds.filter((did) => batch.damageIds.includes(did));
      if (overlap.length > 0) {
        referencedBy.push({
          batchId: other.id,
          batchName: other.name,
          completedAt: other.completedAt,
          overlappingDamageIds: overlap
        });
      }
    });
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
    const batchBefore = snapshot.batchBefore;
    Object.assign(batch, {
      status: batchBefore.status,
      completedAt: batchBefore.completedAt,
      note: batchBefore.note ?? batch.note
    });

    Object.keys(snapshot.damagesBefore).forEach((did) => {
      const savedDamage = snapshot.damagesBefore[did];
      const damage = db.damages.find((d) => d.id === did);
      if (damage) {
        Object.assign(damage, {
          status: savedDamage.status,
          afterPhotoUrl: savedDamage.afterPhotoUrl,
          repairNote: savedDamage.repairNote,
          repairedAt: savedDamage.repairedAt
        });
      }
    });

    if (snapshot.addedImageIds && snapshot.addedImageIds.length > 0) {
      const addedSet = new Set(snapshot.addedImageIds);
      db.repairImages = db.repairImages.filter((img) => !addedSet.has(img.id));
    }

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
        restoredDamageCount: Object.keys(snapshot.damagesBefore).length,
        removedImageCount: snapshot.addedImageIds ? snapshot.addedImageIds.length : 0
      },
      statusCode: 200,
      res
    });
  }

  if (req.method === "GET" && pathname === "/dashboard/repair-workbench") {
    const type = url.searchParams.get("type");
    const rubbingId = url.searchParams.get("rubbingId");
    const batchId = url.searchParams.get("batchId");
    const data = computeRepairWorkbenchDashboard(db, { type, rubbingId, batchId });
    return send(res, 200, { data });
  }

  function validateImportSubmission(body, db) {
    const rubbings = Array.isArray(body.rubbings) ? body.rubbings : [];
    const damages = Array.isArray(body.damages) ? body.damages : [];

    const existingCodes = new Set(db.rubbings.map((r) => r.code));
    const submittedCodes = new Set();
    const duplicateCodes = [];
    const missingRubbingFields = [];
    const validRubbingIndices = new Set();

    rubbings.forEach((rubbing, index) => {
      const missing = ["code", "source", "paperSize"].filter(
        (field) => rubbing[field] === undefined || rubbing[field] === ""
      );
      if (missing.length) {
        missingRubbingFields.push({ index, fields: missing });
      } else {
        if (existingCodes.has(rubbing.code) || submittedCodes.has(rubbing.code)) {
          duplicateCodes.push(rubbing.code);
        } else {
          submittedCodes.add(rubbing.code);
          validRubbingIndices.add(index);
        }
      }
    });

    const existingRubbingIds = new Set(db.rubbings.map((r) => r.id));
    const submittedRubbingRefs = new Map();
    rubbings.forEach((rubbing, index) => {
      if (validRubbingIndices.has(index) && rubbing.id) {
        submittedRubbingRefs.set(rubbing.id, index);
      }
      if (validRubbingIndices.has(index) && rubbing.code) {
        submittedRubbingRefs.set(rubbing.code, index);
      }
    });

    const missingDamageFields = [];
    const invalidDamageRubbingIds = [];
    const validDamageIndices = new Set();

    damages.forEach((damage, index) => {
      const missing = ["position", "type", "beforePhotoUrl"].filter(
        (field) => damage[field] === undefined || damage[field] === ""
      );
      if (missing.length) {
        missingDamageFields.push({ index, fields: missing });
        return;
      }
      const rubbingRef = damage.rubbingId;
      const refExists =
        rubbingRef &&
        (existingRubbingIds.has(rubbingRef) ||
          submittedRubbingRefs.has(rubbingRef));
      if (!refExists) {
        invalidDamageRubbingIds.push({ index, rubbingId: rubbingRef || null });
      } else {
        validDamageIndices.add(index);
      }
    });

    return {
      rubbings,
      damages,
      importable: {
        rubbings: validRubbingIndices.size,
        damages: validDamageIndices.size
      },
      duplicateCodes,
      missingFields: {
        rubbings: missingRubbingFields,
        damages: missingDamageFields
      },
      invalidDamageRubbingIds,
      validRubbingIndices,
      validDamageIndices,
      submittedRubbingRefs
    };
  }

  if (req.method === "POST" && pathname === "/import/precheck") {
    const body = await parseBody(req);
    const result = validateImportSubmission(body, db);
    return send(res, 200, {
      importable: result.importable,
      duplicateCodes: result.duplicateCodes,
      missingFields: result.missingFields,
      invalidDamageRubbingIds: result.invalidDamageRubbingIds
    });
  }

  if (req.method === "POST" && pathname === "/import/confirm") {
    const body = await parseBody(req);
    const result = validateImportSubmission(body, db);

    const idMap = new Map();
    result.rubbings.forEach((rubbing, index) => {
      if (!result.validRubbingIndices.has(index)) return;
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
    });

    const importedDamages = [];
    result.damages.forEach((damage, index) => {
      if (!result.validDamageIndices.has(index)) return;
      let rubbingId = damage.rubbingId;
      if (idMap.has(rubbingId)) rubbingId = idMap.get(rubbingId);
      const record = {
        id: makeId("damage"),
        rubbingId,
        position: damage.position,
        type: damage.type,
        beforePhotoUrl: damage.beforePhotoUrl,
        afterPhotoUrl: damage.afterPhotoUrl || "",
        status: damage.status || "pending",
        repairNote: damage.repairNote || "",
        batchId: null,
        reviewStatus: damage.reviewStatus || "review_pending",
        rejectReason: damage.rejectReason || "",
        createdAt: new Date().toISOString(),
        repairedAt: null
      };
      db.damages.push(record);
      importedDamages.push(record);
    });

    await writeDb(db);
    return send(res, 201, {
      imported: {
        rubbings: result.importable.rubbings,
        damages: result.importable.damages
      },
      duplicateCodes: result.duplicateCodes,
      skipped: {
        rubbings: result.rubbings.length - result.importable.rubbings,
        damages: result.damages.length - result.importable.damages
      }
    });
  }

  if (req.method === "GET" && pathname === "/schedules") {
    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");
    const statusFilter = url.searchParams.get("status");

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
    const csv = exportRubbingsCsv(db, { startDate, endDate });
    const filename = `拓片数据_${new Date().toISOString().slice(0, 10)}.csv`;
    return sendCsv(res, filename, csv);
  }

  if (req.method === "GET" && pathname === "/export/damages") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");
    const csv = exportDamagesCsv(db, { status, type, startDate, endDate });
    const filename = `缺损项数据_${new Date().toISOString().slice(0, 10)}.csv`;
    return sendCsv(res, filename, csv);
  }

  if (req.method === "GET" && pathname === "/export/batches") {
    const status = url.searchParams.get("status");
    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");
    const csv = exportBatchesCsv(db, { status, startDate, endDate });
    const filename = `批次数据_${new Date().toISOString().slice(0, 10)}.csv`;
    return sendCsv(res, filename, csv);
  }

  if (req.method === "GET" && pathname === "/export/repair-results") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");
    const csv = exportRepairResultsCsv(db, { status, type, startDate, endDate });
    const filename = `修补结果数据_${new Date().toISOString().slice(0, 10)}.csv`;
    return sendCsv(res, filename, csv);
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

  const backupRestoreMatch = pathname.match(/^\/backups\/([^/]+)\/restore$/);
  if (backupRestoreMatch && req.method === "POST") {
    const filename = sanitizeBackupFilename(decodeURIComponent(backupRestoreMatch[1]));
    try {
      const result = await restoreFromBackup(filename);
      return send(res, 200, { data: result });
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
    const logs = await readAuditLog();
    const filtered = queryAuditLogs(logs, { actionType, targetId });
    return send(res, 200, { data: filtered, total: filtered.length });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});
