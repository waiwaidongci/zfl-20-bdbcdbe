const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3020);
const DB_FILE = path.join(__dirname, "data", "db.json");

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
  repairImages: []
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
  "POST /import/precheck",
  "POST /import/confirm",
  "GET /dashboard/repair-workbench?type=&rubbingId=&batchId=",
  "GET /rubbings/:id/summary",
  "GET /schedules?startDate=&endDate=&status="
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
  return data;
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
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

function validateImageEntry(entry, index) {
  const errors = [];
  if (!entry.stage || !VALID_STAGES.includes(entry.stage)) {
    errors.push(`第${index + 1}张图片阶段无效，必须是 before_repair / during_repair / after_repair`);
  }
  if (!entry.url || typeof entry.url !== "string" || entry.url.trim() === "") {
    errors.push(`第${index + 1}张图片URL不能为空`);
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
    return send(res, 201, { data: rubbing });
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
    return send(res, 201, { data: damage });
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
    return send(res, 200, { data: { ...normalizeDamage(damage), images: groupImagesByStage(images) } });
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
    return send(res, 201, { data: enrichBatch(db, batch) });
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
        db.repairImages.push(record);
      });
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
    return send(res, 200, { data: enrichBatch(db, batch) });
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

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});
