const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const testHelper = require("./test-helper");

const BACKUP_FILE = path.join(__dirname, "data", "db.json.auditbackup");
const AUDIT_BACKUP_FILE = path.join(__dirname, "data", "audit-logs.json.auditbackup");
const CONFIGURED_PORT = process.env.TEST_AUDIT_PORT ? Number(process.env.TEST_AUDIT_PORT) : null;

let server;
let baseUrl;
let passed = 0;
let failed = 0;

function backupDb() {
  testHelper.backupDb(BACKUP_FILE);
}

function restoreDb() {
  testHelper.restoreDb(BACKUP_FILE);
}

function writeDb(data) {
  testHelper.writeDb(data);
}

function backupAuditLog() {
  const fs = require("fs");
  const auditFile = path.join(__dirname, "data", "audit-logs.json");
  if (fs.existsSync(auditFile)) {
    fs.copyFileSync(auditFile, AUDIT_BACKUP_FILE);
  }
}

function restoreAuditLog() {
  const fs = require("fs");
  const auditFile = path.join(__dirname, "data", "audit-logs.json");
  if (fs.existsSync(AUDIT_BACKUP_FILE)) {
    fs.copyFileSync(AUDIT_BACKUP_FILE, auditFile);
    try {
      fs.unlinkSync(AUDIT_BACKUP_FILE);
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

function startServer() {
  return new Promise(async (resolve, reject) => {
    const port = CONFIGURED_PORT || await findAvailablePort();
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
    }, 3000);

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
}

function stopServer() {
  return new Promise((resolve) => {
    if (server) {
      server.kill("SIGTERM");
      server.on("close", resolve);
      setTimeout(resolve, 500);
    } else {
      resolve();
    }
  });
}

function httpRequest(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = `${baseUrl}${pathname}`;
    const options = {
      method,
      headers: { "Content-Type": "application/json" }
    };
    const req = http.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let parsed = data;
        try {
          parsed = JSON.parse(data);
        } catch (_) {}
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${message}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed += 1;
    console.log(`  ✅ ${message}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${message} (expected: ${expected}, actual: ${actual})`);
  }
}

function assertNotNull(value, message) {
  if (value !== null && value !== undefined) {
    passed += 1;
    console.log(`  ✅ ${message}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${message} (value is null/undefined)`);
  }
}

function seedTestDb() {
  writeDb({
    rubbings: [
      { id: "r1", code: "TP-清-014", source: "地方碑刻残页", paperSize: "42x68cm", note: "边缘有旧折痕", createdAt: "2026-01-15T00:00:00.000Z" }
    ],
    damages: [
      { id: "d1", rubbingId: "r1", position: "左上角", type: "虫蛀孔", beforePhotoUrl: "https://example.com/before1.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, reviewStatus: "review_pending", rejectReason: "", reviewedBy: null, reviewedAt: null, createdAt: "2026-01-16T00:00:00.000Z", repairedAt: null },
      { id: "d2", rubbingId: "r1", position: "下边缘", type: "撕裂", beforePhotoUrl: "https://example.com/before2.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, reviewStatus: "review_pending", rejectReason: "", reviewedBy: null, reviewedAt: null, createdAt: "2026-01-16T00:00:00.000Z", repairedAt: null },
      { id: "d3", rubbingId: "r1", position: "中央", type: "霉斑", beforePhotoUrl: "https://example.com/before3.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, reviewStatus: "approved", rejectReason: "", reviewedBy: "初始审核", reviewedAt: "2026-01-17T00:00:00.000Z", createdAt: "2026-01-15T00:00:00.000Z", repairedAt: null }
    ],
    batches: [],
    repairImages: [],
    batchSnapshots: []
  });
}

function clearAuditLog() {
  const fs = require("fs");
  const auditFile = path.join(__dirname, "data", "audit-logs.json");
  fs.writeFileSync(auditFile, JSON.stringify([], null, 2));
}

async function runTests() {
  console.log("\n=== 审计日志扩展功能测试 ===");

  console.log("\n【场景1】审核通过操作有审计日志记录");
  seedTestDb();
  clearAuditLog();
  await startServer();

  const approveRes = await httpRequest("POST", "/damages/d1/approve", { reviewedBy: "张审核" });
  assertEqual(approveRes.status, 200, "审核通过返回 200");

  const auditAfterApprove = await httpRequest("GET", "/audit-logs?actionType=approve_damage");
  assertEqual(auditAfterApprove.body.total, 1, "有1条审核通过审计记录");
  assertEqual(auditAfterApprove.body.data[0].actionType, "approve_damage", "动作类型为 approve_damage");
  assertEqual(auditAfterApprove.body.data[0].targetType, "damage", "目标类型为 damage");
  assertEqual(auditAfterApprove.body.data[0].targetId, "d1", "目标ID为 d1");
  assertEqual(auditAfterApprove.body.data[0].success, true, "操作成功标记为 true");
  assertNotNull(auditAfterApprove.body.data[0].changeSummary, "有 changeSummary");
  assert(auditAfterApprove.body.data[0].changeSummary.includes("审核通过"), "changeSummary 包含审核通过");
  assert(auditAfterApprove.body.data[0].changeSummary.includes("张审核"), "changeSummary 包含审核人");
  assert(auditAfterApprove.body.data[0].changeSummary.includes("review_pending"), "changeSummary 包含旧状态");
  assert(auditAfterApprove.body.data[0].changeSummary.includes("approved"), "changeSummary 包含新状态");
  assertNotNull(auditAfterApprove.body.data[0].oldValues, "有 oldValues");
  assertNotNull(auditAfterApprove.body.data[0].newValues, "有 newValues");
  assertEqual(auditAfterApprove.body.data[0].oldValues.reviewStatus, "review_pending", "oldValues 中审核状态为待审核");
  assertEqual(auditAfterApprove.body.data[0].newValues.reviewStatus, "approved", "newValues 中审核状态为已通过");

  await stopServer();

  console.log("\n【场景2】审核驳回操作有审计日志记录");
  seedTestDb();
  clearAuditLog();
  await startServer();

  const rejectRes = await httpRequest("POST", "/damages/d2/reject", { reason: "照片不清晰", reviewedBy: "李审核" });
  assertEqual(rejectRes.status, 200, "审核驳回返回 200");

  const auditAfterReject = await httpRequest("GET", "/audit-logs?actionType=reject_damage");
  assertEqual(auditAfterReject.body.total, 1, "有1条审核驳回审计记录");
  assertEqual(auditAfterReject.body.data[0].actionType, "reject_damage", "动作类型为 reject_damage");
  assertEqual(auditAfterReject.body.data[0].targetType, "damage", "目标类型为 damage");
  assert(auditAfterReject.body.data[0].changeSummary.includes("审核驳回"), "changeSummary 包含审核驳回");
  assert(auditAfterReject.body.data[0].changeSummary.includes("李审核"), "changeSummary 包含审核人");
  assert(auditAfterReject.body.data[0].changeSummary.includes("照片不清晰"), "changeSummary 包含驳回原因");

  await stopServer();

  console.log("\n【场景3】影像归档操作有审计日志记录");
  seedTestDb();
  clearAuditLog();
  await startServer();

  const imageRes = await httpRequest("POST", "/damages/d3/images", {
    images: [
      { stage: "after_repair", url: "https://example.com/after1.jpg", isPrimary: true, description: "修补后照片" },
      { stage: "during_repair", url: "https://example.com/during1.jpg", description: "修补中照片" }
    ]
  });
  assertEqual(imageRes.status, 201, "影像归档返回 201");

  const auditAfterArchive = await httpRequest("GET", "/audit-logs?actionType=archive_images");
  assertEqual(auditAfterArchive.body.total, 1, "有1条影像归档审计记录");
  assertEqual(auditAfterArchive.body.data[0].actionType, "archive_images", "动作类型为 archive_images");
  assertEqual(auditAfterArchive.body.data[0].targetType, "damage", "目标类型为 damage");
  assertEqual(auditAfterArchive.body.data[0].targetId, "d3", "目标ID为 d3");
  assert(auditAfterArchive.body.data[0].changeSummary.includes("影像归档"), "changeSummary 包含影像归档");
  assert(auditAfterArchive.body.data[0].changeSummary.includes("d3"), "changeSummary 包含缺损ID");
  assert(auditAfterArchive.body.data[0].changeSummary.includes("2"), "changeSummary 包含影像数量");
  assertNotNull(auditAfterArchive.body.data[0].extra, "有 extra 字段");
  assertEqual(auditAfterArchive.body.data[0].extra.imageCount, 2, "extra 中 imageCount 为 2");

  await stopServer();

  console.log("\n【场景4】导入确认操作有审计日志记录");
  seedTestDb();
  clearAuditLog();
  await startServer();

  const importData = {
    rubbings: [
      { code: "TP-导入-001", source: "导入来源1", paperSize: "30x40cm" },
      { code: "TP-导入-002", source: "导入来源2", paperSize: "50x60cm" }
    ],
    damages: [
      { rubbingId: "TP-导入-001", position: "导入位置1", type: "虫蛀", beforePhotoUrl: "https://example.com/import1.jpg" },
      { rubbingId: "TP-导入-001", position: "导入位置2", type: "撕裂", beforePhotoUrl: "https://example.com/import2.jpg" }
    ]
  };

  const precheckRes = await httpRequest("POST", "/import/precheck", importData);
  assertEqual(precheckRes.status, 200, "导入预检返回 200");

  const confirmRes = await httpRequest("POST", "/import/confirm", {
    ...importData,
    precheckToken: precheckRes.body.precheckToken
  });
  assertEqual(confirmRes.status, 201, "导入确认返回 201");

  const auditAfterImport = await httpRequest("GET", "/audit-logs?actionType=import_confirm");
  assertEqual(auditAfterImport.body.total, 1, "有1条导入确认审计记录");
  assertEqual(auditAfterImport.body.data[0].actionType, "import_confirm", "动作类型为 import_confirm");
  assertEqual(auditAfterImport.body.data[0].targetType, "import", "目标类型为 import");
  assert(auditAfterImport.body.data[0].changeSummary.includes("导入确认"), "changeSummary 包含导入确认");
  assert(auditAfterImport.body.data[0].changeSummary.includes("2"), "changeSummary 包含导入拓片数");
  assert(auditAfterImport.body.data[0].changeSummary.includes("2"), "changeSummary 包含导入缺损数");
  assertNotNull(auditAfterImport.body.data[0].extra, "有 extra 字段");
  assertEqual(auditAfterImport.body.data[0].extra.imported.rubbings, 2, "extra 中导入拓片数为 2");
  assertEqual(auditAfterImport.body.data[0].extra.imported.damages, 2, "extra 中导入缺损数为 2");

  await stopServer();

  console.log("\n【场景5】备份恢复操作有审计日志记录");
  seedTestDb();
  clearAuditLog();
  await startServer();

  const backupRes = await httpRequest("POST", "/backups");
  assertEqual(backupRes.status, 201, "创建备份返回 201");
  const backupFilename = backupRes.body.data.filename;
  assertNotNull(backupFilename, "备份文件名存在");

  const restoreRes = await httpRequest("POST", `/backups/${encodeURIComponent(backupFilename)}/restore`);
  assertEqual(restoreRes.status, 200, "备份恢复返回 200");

  const auditAfterRestore = await httpRequest("GET", "/audit-logs?actionType=restore_backup");
  assertEqual(auditAfterRestore.body.total, 1, "有1条备份恢复审计记录");
  assertEqual(auditAfterRestore.body.data[0].actionType, "restore_backup", "动作类型为 restore_backup");
  assertEqual(auditAfterRestore.body.data[0].targetType, "backup", "目标类型为 backup");
  assertEqual(auditAfterRestore.body.data[0].targetId, backupFilename, "目标ID为备份文件名");
  assert(auditAfterRestore.body.data[0].changeSummary.includes("备份恢复"), "changeSummary 包含备份恢复");
  assert(auditAfterRestore.body.data[0].changeSummary.includes(backupFilename), "changeSummary 包含备份文件名");
  assertNotNull(auditAfterRestore.body.data[0].oldValues, "有 oldValues");
  assertNotNull(auditAfterRestore.body.data[0].newValues, "有 newValues");

  await stopServer();

  console.log("\n【场景6】按 targetType 筛选审计日志");
  seedTestDb();
  clearAuditLog();
  await startServer();

  await httpRequest("POST", "/damages/d1/approve", { reviewedBy: "审核员A" });
  await httpRequest("POST", "/damages/d2/reject", { reason: "原因A", reviewedBy: "审核员B" });
  await httpRequest("POST", "/rubbings", { code: "TP-筛选测试", source: "测试来源", paperSize: "10x10cm" });

  const allLogs = await httpRequest("GET", "/audit-logs");
  assertEqual(allLogs.body.total, 3, "总共有3条审计记录");

  const damageLogs = await httpRequest("GET", "/audit-logs?targetType=damage");
  assertEqual(damageLogs.body.total, 2, "按 targetType=damage 筛选出2条记录");
  assert(damageLogs.body.data.every((e) => e.targetType === "damage"), "所有记录的 targetType 都是 damage");

  const rubbingLogs = await httpRequest("GET", "/audit-logs?targetType=rubbing");
  assertEqual(rubbingLogs.body.total, 1, "按 targetType=rubbing 筛选出1条记录");
  assertEqual(rubbingLogs.body.data[0].targetType, "rubbing", "记录的 targetType 是 rubbing");

  const backupLogs = await httpRequest("GET", "/audit-logs?targetType=backup");
  assertEqual(backupLogs.body.total, 0, "按 targetType=backup 筛选出0条记录");

  await stopServer();

  console.log("\n【场景7】按时间范围筛选审计日志");
  seedTestDb();
  clearAuditLog();
  await startServer();

  await httpRequest("POST", "/damages/d1/approve", { reviewedBy: "审核员1" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const midTime = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await httpRequest("POST", "/damages/d2/reject", { reason: "测试", reviewedBy: "审核员2" });

  const allTimeLogs = await httpRequest("GET", "/audit-logs");
  assertEqual(allTimeLogs.body.total, 2, "时间范围内共有2条记录");

  const startFilter = await httpRequest("GET", `/audit-logs?startDate=${encodeURIComponent(midTime)}`);
  assertEqual(startFilter.body.total, 1, "按 startDate 筛选出1条记录");
  assertEqual(startFilter.body.data[0].actionType, "reject_damage", "筛选出的是较新的驳回记录");

  const endFilter = await httpRequest("GET", `/audit-logs?endDate=${encodeURIComponent(midTime)}`);
  assertEqual(endFilter.body.total, 1, "按 endDate 筛选出1条记录");
  assertEqual(endFilter.body.data[0].actionType, "approve_damage", "筛选出的是较旧的通过记录");

  const rangeFilter = await httpRequest("GET", `/audit-logs?startDate=${encodeURIComponent(new Date(Date.now() - 5000).toISOString())}&endDate=${encodeURIComponent(new Date(Date.now() + 5000).toISOString())}`);
  assertEqual(rangeFilter.body.total, 2, "完整时间范围内有2条记录");

  const emptyRangeFilter = await httpRequest("GET", `/audit-logs?startDate=${encodeURIComponent(new Date(Date.now() + 10000).toISOString())}`);
  assertEqual(emptyRangeFilter.body.total, 0, "未来时间范围筛选出0条记录");

  await stopServer();

  console.log("\n【场景8】按操作结果筛选审计日志");
  seedTestDb();
  clearAuditLog();
  await startServer();

  await httpRequest("POST", "/damages/d1/approve", { reviewedBy: "审核员" });

  const successLogs = await httpRequest("GET", "/audit-logs?success=true");
  assertEqual(successLogs.body.total, 1, "按 success=true 筛选出1条记录");
  assert(successLogs.body.data.every((e) => e.success === true), "所有记录都是成功的");

  const failureLogs = await httpRequest("GET", "/audit-logs?success=false");
  assertEqual(failureLogs.body.total, 0, "按 success=false 筛选出0条记录");

  const allLogs2 = await httpRequest("GET", "/audit-logs");
  assertEqual(allLogs2.body.total, 1, "不按 success 筛选有1条记录");

  await stopServer();

  console.log("\n【场景9】组合筛选条件");
  seedTestDb();
  clearAuditLog();
  await startServer();

  await httpRequest("POST", "/damages/d1/approve", { reviewedBy: "审核员A" });
  await httpRequest("POST", "/damages/d2/reject", { reason: "原因A", reviewedBy: "审核员B" });
  await httpRequest("POST", "/rubbings", { code: "TP-组合测试", source: "测试", paperSize: "10x10cm" });

  const comboFilter = await httpRequest("GET", "/audit-logs?targetType=damage&actionType=approve_damage&success=true");
  assertEqual(comboFilter.body.total, 1, "组合筛选出1条记录");
  assertEqual(comboFilter.body.data[0].actionType, "approve_damage", "动作类型正确");
  assertEqual(comboFilter.body.data[0].targetType, "damage", "目标类型正确");
  assertEqual(comboFilter.body.data[0].success, true, "成功标记正确");

  await stopServer();

  console.log("\n【场景10】所有审计条目都包含 success 字段（向后兼容验证）");
  seedTestDb();
  clearAuditLog();
  await startServer();

  await httpRequest("POST", "/rubbings", { code: "TP-兼容测试", source: "测试来源", paperSize: "20x30cm" });
  await httpRequest("POST", "/damages/d1/approve", { reviewedBy: "兼容审核" });
  await httpRequest("POST", "/damages/d3/images", { stage: "after_repair", url: "https://example.com/test.jpg" });

  const allWithSuccess = await httpRequest("GET", "/audit-logs");
  assert(allWithSuccess.body.data.length > 0, "有多条审计记录");
  assert(allWithSuccess.body.data.every((e) => e.success === true), "所有记录都有 success 字段且为 true");
  assert(allWithSuccess.body.data.every((e) => e.changeSummary && typeof e.changeSummary === "string"), "所有记录都有 changeSummary");
  assert(allWithSuccess.body.data.every((e) => e.timestamp), "所有记录都有 timestamp");
  assert(allWithSuccess.body.data.every((e) => e.actionType), "所有记录都有 actionType");
  assert(allWithSuccess.body.data.every((e) => e.targetType), "所有记录都有 targetType");
  assert(allWithSuccess.body.data.every((e) => e.targetId), "所有记录都有 targetId");

  await stopServer();

  console.log("\n=== 测试总结 ===");
  console.log(`通过: ${passed}, 失败: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

async function main() {
  try {
    backupDb();
    backupAuditLog();
    await runTests();
  } catch (err) {
    console.error("\n❌ 测试执行出错:", err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await stopServer();
    restoreDb();
    restoreAuditLog();
  }
}

main();
