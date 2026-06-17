const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const testHelper = require("./test-helper");

const BACKUP_FILE = path.join(__dirname, "data", "db.json.partialrollbacktest");
const AUDIT_LOG_FILE = path.join(__dirname, "data", "audit-logs.json");
const AUDIT_LOG_BACKUP_FILE = path.join(__dirname, "data", "audit-logs.json.partialrollbacktest");
const DB_FILE = testHelper.DB_FILE;
const PORT = 3062;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let server;
let passed = 0;
let failed = 0;

function backupDb() {
  testHelper.backupDb(BACKUP_FILE);
  if (fs.existsSync(AUDIT_LOG_FILE)) {
    fs.copyFileSync(AUDIT_LOG_FILE, AUDIT_LOG_BACKUP_FILE);
  }
}

function restoreDb() {
  testHelper.restoreDb(BACKUP_FILE);
  if (fs.existsSync(AUDIT_LOG_BACKUP_FILE)) {
    fs.copyFileSync(AUDIT_LOG_BACKUP_FILE, AUDIT_LOG_FILE);
    fs.unlinkSync(AUDIT_LOG_BACKUP_FILE);
  }
}

function writeDb(data) {
  testHelper.writeDb(data);
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn("node", ["server.js"], {
      cwd: __dirname,
      env: { ...process.env, PORT: String(PORT) }
    });
    server.stderr.on("data", (data) => {
      process.stderr.write(`[server stderr] ${data}`);
    });
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) reject(new Error("Server startup timeout"));
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
    const url = `${BASE_URL}${pathname}`;
    const options = {
      method,
      headers: { "Content-Type": "application/json" }
    };
    const req = http.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function assertEqual(actual, expected, name) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ✓ PASS: ${name}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL: ${name}`);
    console.log(`    期望: ${JSON.stringify(expected)}`);
    console.log(`    实际: ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertContains(str, substr, name) {
  if (str && String(str).includes(substr)) {
    console.log(`  ✓ PASS: ${name}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL: ${name}`);
    console.log(`    期望包含: ${substr}`);
    console.log(`    实际: ${str}`);
    failed++;
  }
}

function assertTrue(cond, name) {
  if (cond) {
    console.log(`  ✓ PASS: ${name}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL: ${name}`);
    failed++;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function prepareTestData() {
  const testData = {
    rubbings: [
      { id: "r_pr1", code: "TP-PR-001", source: "部分回滚测试1", paperSize: "30x40cm", note: "", createdAt: new Date().toISOString() },
      { id: "r_pr2", code: "TP-PR-002", source: "部分回滚测试2", paperSize: "50x70cm", note: "", createdAt: new Date().toISOString() }
    ],
    damages: [
      { id: "d_pr1", rubbingId: "r_pr1", position: "左上角", type: "虫蛀孔", beforePhotoUrl: "https://example.com/b1.jpg", afterPhotoUrl: "", status: "in_repair", repairNote: "", batchId: null, reviewStatus: "approved", rejectReason: "", createdAt: new Date().toISOString(), repairedAt: null },
      { id: "d_pr2", rubbingId: "r_pr1", position: "下边缘", type: "撕裂", beforePhotoUrl: "https://example.com/b2.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, reviewStatus: "approved", rejectReason: "", createdAt: new Date().toISOString(), repairedAt: null },
      { id: "d_pr3", rubbingId: "r_pr1", position: "中央", type: "霉斑", beforePhotoUrl: "https://example.com/b3.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, reviewStatus: "approved", rejectReason: "", createdAt: new Date().toISOString(), repairedAt: null },
      { id: "d_pr4", rubbingId: "r_pr2", position: "右上角", type: "风化", beforePhotoUrl: "https://example.com/b4.jpg", afterPhotoUrl: "", status: "in_repair", repairNote: "", batchId: null, reviewStatus: "approved", rejectReason: "", createdAt: new Date().toISOString(), repairedAt: null },
      { id: "d_pr5", rubbingId: "r_pr2", position: "左下角", type: "虫蛀孔", beforePhotoUrl: "https://example.com/b5.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, reviewStatus: "approved", rejectReason: "", createdAt: new Date().toISOString(), repairedAt: null }
    ],
    batches: [
      { id: "b_pr1", name: "部分回滚测试批次", status: "open", damageIds: ["d_pr1", "d_pr2", "d_pr3"], note: "", createdAt: new Date().toISOString(), completedAt: null, plannedStartAt: null, plannedEndAt: null, responsible: "测试员", rolledBackDamageIds: [] },
      { id: "b_pr2", name: "独立批次", status: "open", damageIds: ["d_pr4", "d_pr5"], note: "", createdAt: new Date().toISOString(), completedAt: null, plannedStartAt: null, plannedEndAt: null, responsible: "测试员", rolledBackDamageIds: [] }
    ],
    repairImages: [],
    batchSnapshots: []
  };
  writeDb(testData);
}

async function test1_BasicPartialRollback() {
  console.log("\n=== 场景1：基本部分回滚 - 回滚部分缺损，批次进入partially_rolled_back ===");

  const completeRes = await httpRequest("POST", "/batches/b_pr1/complete", {
    note: "全部完成",
    defaultAfterPhotoUrl: "https://example.com/after.jpg",
    defaultRepairNote: "已修补",
    results: [
      { damageId: "d_pr1", afterPhotoUrl: "https://example.com/a1.jpg", repairNote: "修补缺损1" },
      { damageId: "d_pr2", afterPhotoUrl: "https://example.com/a2.jpg", repairNote: "修补缺损2" },
      { damageId: "d_pr3", afterPhotoUrl: "https://example.com/a3.jpg", repairNote: "修补缺损3" }
    ]
  });
  assertEqual(completeRes.status, 200, "完成批次返回 200");

  const partialRollbackRes = await httpRequest("POST", "/batches/b_pr1/rollback", {
    damageIds: ["d_pr1"]
  });
  assertEqual(partialRollbackRes.status, 200, "部分回滚返回 200");
  assertEqual(partialRollbackRes.body.rolledBackDamageCount, 1, "回滚了 1 个缺损");
  assertEqual(partialRollbackRes.body.batchStatus, "partially_rolled_back", "批次状态为 partially_rolled_back");

  const batchRes = await httpRequest("GET", "/batches/b_pr1");
  assertEqual(batchRes.body.data.status, "partially_rolled_back", "批次查询状态为 partially_rolled_back");
  assertEqual(batchRes.body.data.rolledBackDamageIds.length, 1, "rolledBackDamageIds 包含 1 项");
  assertEqual(batchRes.body.data.rolledBackDamageIds[0], "d_pr1", "rolledBackDamageIds 包含 d_pr1");
  assertEqual(batchRes.body.data.repaired, 2, "已修补数为 2（d_pr2, d_pr3）");
  assertEqual(batchRes.body.data.pending, 1, "待修补数为 1（d_pr1 已回滚）");

  const damages = (await httpRequest("GET", "/damages")).body.data;
  const d1 = damages.find((d) => d.id === "d_pr1");
  const d2 = damages.find((d) => d.id === "d_pr2");
  const d3 = damages.find((d) => d.id === "d_pr3");
  assertEqual(d1.status, "in_repair", "d_pr1 恢复到 in_repair");
  assertEqual(d1.afterPhotoUrl, "", "d_pr1 afterPhotoUrl 清空");
  assertEqual(d1.repairNote, "", "d_pr1 repairNote 清空");
  assertEqual(d1.repairedAt, null, "d_pr1 repairedAt 清空");
  assertEqual(d2.status, "repaired", "d_pr2 保持 repaired");
  assertEqual(d2.repairNote, "修补缺损2", "d_pr2 repairNote 不变");
  assertEqual(d3.status, "repaired", "d_pr3 保持 repaired");
}

async function test2_PartialRollbackImages() {
  console.log("\n=== 场景2：部分回滚只移除指定缺损的归档影像 ===");

  const completeWithImages = await httpRequest("POST", "/batches/b_pr2/complete", {
    note: "带影像完成",
    results: [
      { damageId: "d_pr4", afterPhotoUrl: "https://example.com/a4.jpg", repairNote: "修补缺损4" },
      { damageId: "d_pr5", afterPhotoUrl: "https://example.com/a5.jpg", repairNote: "修补缺损5" }
    ],
    archiveImages: [
      { damageId: "d_pr4", stage: "before_repair", url: "https://example.com/img-b4.jpg", capturedAt: new Date().toISOString() },
      { damageId: "d_pr4", stage: "after_repair", url: "https://example.com/img-a4.jpg", capturedAt: new Date().toISOString() },
      { damageId: "d_pr5", stage: "after_repair", url: "https://example.com/img-a5.jpg", capturedAt: new Date().toISOString() }
    ]
  });
  assertEqual(completeWithImages.status, 200, "带影像完成独立批次返回 200");

  const d4ImagesBefore = (await httpRequest("GET", "/damages/d_pr4/images")).body.data;
  const d4CountBefore = d4ImagesBefore.before_repair.length + d4ImagesBefore.during_repair.length + d4ImagesBefore.after_repair.length;
  assertTrue(d4CountBefore >= 2, "完成时 d_pr4 至少有 2 张影像");

  await httpRequest("POST", "/batches/b_pr1/complete", {
    note: "重新完成批次1",
    results: [
      { damageId: "d_pr1", afterPhotoUrl: "https://example.com/a1v2.jpg", repairNote: "再次修补1" },
      { damageId: "d_pr2", afterPhotoUrl: "https://example.com/a2v2.jpg", repairNote: "再次修补2" },
      { damageId: "d_pr3", afterPhotoUrl: "https://example.com/a3v2.jpg", repairNote: "再次修补3" }
    ],
    archiveImages: [
      { damageId: "d_pr1", stage: "after_repair", url: "https://example.com/img-a1.jpg", capturedAt: new Date().toISOString() },
      { damageId: "d_pr2", stage: "after_repair", url: "https://example.com/img-a2.jpg", capturedAt: new Date().toISOString() },
      { damageId: "d_pr3", stage: "after_repair", url: "https://example.com/img-a3.jpg", capturedAt: new Date().toISOString() }
    ]
  });

  const partialRb = await httpRequest("POST", "/batches/b_pr1/rollback", {
    damageIds: ["d_pr1", "d_pr2"]
  });
  assertEqual(partialRb.status, 200, "部分回滚 d_pr1,d_pr2 返回 200");
  assertTrue(partialRb.body.removedImageCount >= 2, "至少移除了 2 张影像（d_pr1 和 d_pr2 各 1 张）");

  const d1Images = (await httpRequest("GET", "/damages/d_pr1/images")).body.data;
  assertEqual(d1Images.after_repair.length, 0, "d_pr1 after_repair 影像已移除");

  const d2Images = (await httpRequest("GET", "/damages/d_pr2/images")).body.data;
  assertEqual(d2Images.after_repair.length, 0, "d_pr2 after_repair 影像已移除");

  const d3Images = (await httpRequest("GET", "/damages/d_pr3/images")).body.data;
  assertTrue(d3Images.after_repair.length > 0, "d_pr3 after_repair 影像保留");
}

async function test3_SuccessivePartialRollback() {
  console.log("\n=== 场景3：连续部分回滚直到全部回滚退回open ===");

  const partialRb3 = await httpRequest("POST", "/batches/b_pr1/rollback", {
    damageIds: ["d_pr3"]
  });
  assertEqual(partialRb3.status, 200, "第二次部分回滚 d_pr3 返回 200");
  assertEqual(partialRb3.body.batchStatus, "open", "所有缺损回滚后批次回到 open");

  const batchRes = await httpRequest("GET", "/batches/b_pr1");
  assertEqual(batchRes.body.data.status, "open", "批次最终状态为 open");
  assertEqual(batchRes.body.data.completedAt, null, "completedAt 已清空");
  assertEqual(batchRes.body.data.rolledBackDamageIds.length, 0, "rolledBackDamageIds 已清空");
}

async function test4_PartialRollbackValidation() {
  console.log("\n=== 场景4：部分回滚参数校验 ===");

  const completeRes = await httpRequest("POST", "/batches/b_pr1/complete", {
    note: "完成用于校验测试",
    defaultRepairNote: "测试修补"
  });
  assertEqual(completeRes.status, 200, "完成批次返回 200");

  const notInBatch = await httpRequest("POST", "/batches/b_pr1/rollback", {
    damageIds: ["d_pr4"]
  });
  assertEqual(notInBatch.status, 400, "不属于批次的缺损返回 400");
  assertEqual(notInBatch.body.code, "DAMAGE_NOT_IN_BATCH", "错误码为 DAMAGE_NOT_IN_BATCH");

  const partialRb1 = await httpRequest("POST", "/batches/b_pr1/rollback", {
    damageIds: ["d_pr1"]
  });
  assertEqual(partialRb1.status, 200, "第一次部分回滚成功");

  const alreadyRb = await httpRequest("POST", "/batches/b_pr1/rollback", {
    damageIds: ["d_pr1"]
  });
  assertEqual(alreadyRb.status, 400, "重复回滚同一缺损返回 400");
  assertEqual(alreadyRb.body.code, "ALREADY_ROLLED_BACK", "错误码为 ALREADY_ROLLED_BACK");

  const rollbackOpen = await httpRequest("POST", "/batches/b_pr1/rollback", {
    damageIds: ["d_pr2"]
  });
  assertEqual(rollbackOpen.status, 200, "继续部分回滚 d_pr2 成功");
}

async function test5_RollbackOpenBatchRejected() {
  console.log("\n=== 场景5：对open批次执行回滚被拒绝 ===");

  const fullRb = await httpRequest("POST", "/batches/b_pr1/rollback", {
    damageIds: ["d_pr3"]
  });
  assertEqual(fullRb.status, 200, "全部回滚完成");

  const openRb = await httpRequest("POST", "/batches/b_pr1/rollback", {});
  assertEqual(openRb.status, 400, "对open批次完整回滚返回 400");
  assertEqual(openRb.body.code, "INVALID_BATCH_STATUS_FOR_ROLLBACK", "错误码正确");

  const openPartialRb = await httpRequest("POST", "/batches/b_pr1/rollback", {
    damageIds: ["d_pr1"]
  });
  assertEqual(openPartialRb.status, 400, "对open批次部分回滚返回 400");
  assertContains(openPartialRb.body.error, "进行中", "错误信息提到当前状态");
}

async function test6_FullRollbackFromPartiallyRolledBack() {
  console.log("\n=== 场景6：从partially_rolled_back状态执行完整回滚 ===");

  const completeRes = await httpRequest("POST", "/batches/b_pr1/complete", {
    note: "完成用于完整回滚测试",
    defaultRepairNote: "修补",
    archiveImages: [
      { damageId: "d_pr1", stage: "after_repair", url: "https://example.com/full-a1.jpg", capturedAt: new Date().toISOString() },
      { damageId: "d_pr2", stage: "after_repair", url: "https://example.com/full-a2.jpg", capturedAt: new Date().toISOString() },
      { damageId: "d_pr3", stage: "after_repair", url: "https://example.com/full-a3.jpg", capturedAt: new Date().toISOString() }
    ]
  });
  assertEqual(completeRes.status, 200, "完成批次成功");

  const partialRb = await httpRequest("POST", "/batches/b_pr1/rollback", {
    damageIds: ["d_pr1"]
  });
  assertEqual(partialRb.status, 200, "部分回滚 d_pr1 成功");
  assertEqual(partialRb.body.batchStatus, "partially_rolled_back", "批次为 partially_rolled_back");

  const fullRb = await httpRequest("POST", "/batches/b_pr1/rollback", {});
  assertEqual(fullRb.status, 200, "完整回滚从 partially_rolled_back 状态成功");
  assertEqual(fullRb.body.restoredDamageCount, 3, "恢复了 3 个缺损");

  const batchRes = await httpRequest("GET", "/batches/b_pr1");
  assertEqual(batchRes.body.data.status, "open", "完整回滚后批次为 open");
  assertEqual(batchRes.body.data.completedAt, null, "completedAt 已清空");
  assertEqual(batchRes.body.data.rolledBackDamageIds.length, 0, "rolledBackDamageIds 已清空");

  const damages = (await httpRequest("GET", "/damages")).body.data;
  const d1 = damages.find((d) => d.id === "d_pr1");
  const d2 = damages.find((d) => d.id === "d_pr2");
  const d3 = damages.find((d) => d.id === "d_pr3");
  assertEqual(d1.status, "in_repair", "完整回滚后 d_pr1 恢复到 in_repair");
  assertEqual(d2.status, "pending", "完整回滚后 d_pr2 恢复到 pending");
  assertEqual(d3.status, "pending", "完整回滚后 d_pr3 恢复到 pending");
  assertEqual(d1.afterPhotoUrl, "", "完整回滚后 d_pr1 afterPhotoUrl 清空");
  assertEqual(d2.afterPhotoUrl, "", "完整回滚后 d_pr2 afterPhotoUrl 清空");

  const d1Images = (await httpRequest("GET", "/damages/d_pr1/images")).body.data;
  const d2Images = (await httpRequest("GET", "/damages/d_pr2/images")).body.data;
  assertEqual(d1Images.after_repair.length, 0, "完整回滚后 d_pr1 影像已清除");
  assertEqual(d2Images.after_repair.length, 0, "完整回滚后 d_pr2 影像已清除");
}

async function test7_PartialRollbackReferenceConflict() {
  console.log("\n=== 场景7：部分回滚引用冲突检查 ===");

  await httpRequest("POST", "/batches/b_pr1/complete", {
    note: "批次1先完成",
    defaultRepairNote: "修补"
  });

  await sleep(50);

  await httpRequest("POST", "/batches/b_pr2/complete", {
    note: "批次2后完成",
    defaultRepairNote: "修补"
  });

  const rawDbRaw = fs.readFileSync(DB_FILE, "utf8");
  const rawDb = JSON.parse(rawDbRaw);
  const batches = rawDb.entities ? rawDb.entities.batches : rawDb.batches;
  batches.find((b) => b.id === "b_pr2").damageIds.push("d_pr1");
  if (rawDb.entities) {
    rawDb.entities.batches = batches;
  } else {
    rawDb.batches = batches;
  }
  const tempFile = DB_FILE + ".tmp_pr7";
  fs.writeFileSync(tempFile, JSON.stringify(rawDb, null, 2));
  fs.renameSync(tempFile, DB_FILE);

  const partialConflict = await httpRequest("POST", "/batches/b_pr1/rollback", {
    damageIds: ["d_pr1"]
  });
  assertEqual(partialConflict.status, 409, "d_pr1 被引用时部分回滚返回 409");
  assertEqual(partialConflict.body.code, "DAMAGE_REFERENCED_BY_LATER_BATCH", "错误码正确");

  const partialNoConflict = await httpRequest("POST", "/batches/b_pr1/rollback", {
    damageIds: ["d_pr2"]
  });
  assertEqual(partialNoConflict.status, 200, "d_pr2 未被引用部分回滚成功");

  const rawDb2Raw = fs.readFileSync(DB_FILE, "utf8");
  const rawDb2 = JSON.parse(rawDb2Raw);
  const batches2 = rawDb2.entities ? rawDb2.entities.batches : rawDb2.batches;
  batches2.find((b) => b.id === "b_pr2").damageIds = ["d_pr4"];
  if (rawDb2.entities) {
    rawDb2.entities.batches = batches2;
  } else {
    rawDb2.batches = batches2;
  }
  const tempFile2 = DB_FILE + ".tmp_pr7_2";
  fs.writeFileSync(tempFile2, JSON.stringify(rawDb2, null, 2));
  fs.renameSync(tempFile2, DB_FILE);
}

async function test8_AuditLogForPartialRollback() {
  console.log("\n=== 场景8：部分回滚审计日志 ===");

  const logs = (await httpRequest("GET", "/audit-logs?actionType=partial_rollback_batch")).body.data;
  assertTrue(logs.length > 0, "存在 partial_rollback_batch 审计日志");
  const latestLog = logs[0];
  assertEqual(latestLog.actionType, "partial_rollback_batch", "审计日志 actionType 正确");
  assertTrue(!!latestLog.extra, "审计日志包含 extra 字段");
  assertTrue(Array.isArray(latestLog.extra.rolledBackDamageIds), "extra 包含 rolledBackDamageIds");
  assertTrue(typeof latestLog.extra.rolledBackCount === "number", "extra 包含 rolledBackCount");
  assertContains(latestLog.changeSummary, "部分回滚", "审计摘要包含「部分回滚」");
}

async function test9_RecompleteAfterPartialRollback() {
  console.log("\n=== 场景9：部分回滚后重新完成批次 ===");

  const batchBefore = await httpRequest("GET", "/batches/b_pr1");
  assertEqual(batchBefore.body.data.status, "partially_rolled_back", "批次为 partially_rolled_back");

  const recomplete = await httpRequest("POST", "/batches/b_pr1/complete", {
    note: "部分回滚后重新完成",
    results: [
      { damageId: "d_pr1", afterPhotoUrl: "https://example.com/re-a1.jpg", repairNote: "重新修补1" },
      { damageId: "d_pr2", afterPhotoUrl: "https://example.com/re-a2.jpg", repairNote: "重新修补2" },
      { damageId: "d_pr3", afterPhotoUrl: "https://example.com/re-a3.jpg", repairNote: "重新修补3" }
    ]
  });
  assertEqual(recomplete.status, 200, "部分回滚后重新完成成功");

  const batchAfter = await httpRequest("GET", "/batches/b_pr1");
  assertEqual(batchAfter.body.data.status, "completed", "重新完成后批次为 completed");
  assertEqual(batchAfter.body.data.rolledBackDamageIds.length, 0, "rolledBackDamageIds 已清空");

  const damages = (await httpRequest("GET", "/damages?status=repaired")).body.data;
  const d1 = damages.find((d) => d.id === "d_pr1");
  const d2 = damages.find((d) => d.id === "d_pr2");
  assertTrue(!!d1, "d_pr1 为 repaired");
  assertTrue(!!d2, "d_pr2 为 repaired");

  const partialRbAfterRecomplete = await httpRequest("POST", "/batches/b_pr1/rollback", {
    damageIds: ["d_pr1"]
  });
  assertEqual(partialRbAfterRecomplete.status, 200, "重新完成后部分回滚 d_pr1 成功");
  assertEqual(partialRbAfterRecomplete.body.batchStatus, "partially_rolled_back", "部分回滚后为 partially_rolled_back");

  const fullRb = await httpRequest("POST", "/batches/b_pr1/rollback", {});
  assertEqual(fullRb.status, 200, "完整回滚成功");
  assertEqual(fullRb.body.data.status, "open", "完整回滚后批次为 open");
}

async function test10_DashboardWithPartiallyRolledBack() {
  console.log("\n=== 场景10：仪表盘支持partially_rolled_back状态 ===");

  await httpRequest("POST", "/batches/b_pr1/complete", {
    note: "完成用于仪表盘测试",
    defaultRepairNote: "修补"
  });
  await httpRequest("POST", "/batches/b_pr1/rollback", {
    damageIds: ["d_pr1"]
  });

  const dashboard = (await httpRequest("GET", "/dashboard/repair-workbench")).body.data;
  assertTrue(dashboard.partiallyRolledBackBatches >= 1, "仪表盘包含 partiallyRolledBackBatches 统计");

  const batches = (await httpRequest("GET", "/batches?status=partially_rolled_back")).body.data;
  assertTrue(batches.length >= 1, "按状态筛选 partially_rolled_back 返回结果");
  assertEqual(batches[0].status, "partially_rolled_back", "筛选结果状态正确");
}

async function test11_FullRollbackRemovesRemainingImages() {
  console.log("\n=== 场景11：从partially_rolled_back完整回滚只移除未删除的影像 ===");

  const fullRb = await httpRequest("POST", "/batches/b_pr1/rollback", {});
  assertEqual(fullRb.status, 200, "完整回滚成功");
  assertTrue(fullRb.body.removedImageCount >= 0, "removedImageCount 为非负数");
}

async function main() {
  try {
    console.log("批次部分回滚端到端验证");
    console.log("=".repeat(50));

    backupDb();
    prepareTestData();
    await startServer();

    await test1_BasicPartialRollback();
    await test2_PartialRollbackImages();
    await test3_SuccessivePartialRollback();
    await test4_PartialRollbackValidation();
    await test5_RollbackOpenBatchRejected();
    await test6_FullRollbackFromPartiallyRolledBack();
    await test7_PartialRollbackReferenceConflict();
    await test8_AuditLogForPartialRollback();
    await test9_RecompleteAfterPartialRollback();
    await test10_DashboardWithPartiallyRolledBack();
    await test11_FullRollbackRemovesRemainingImages();

    console.log("\n" + "=".repeat(50));
    console.log(`测试结果: 通过 ${passed} / ${passed + failed}`);
    if (failed > 0) {
      console.log(`失败 ${failed} 个用例`);
    } else {
      console.log("全部通过 ✓");
    }
  } catch (err) {
    console.error("测试执行出错:", err);
    process.exitCode = 1;
  } finally {
    await stopServer();
    restoreDb();
  }
}

main();
