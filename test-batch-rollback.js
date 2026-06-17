const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const testHelper = require("./test-helper");

const BACKUP_FILE = path.join(__dirname, "data", "db.json.rollbacktest");
const AUDIT_LOG_FILE = path.join(__dirname, "data", "audit-logs.json");
const AUDIT_LOG_BACKUP_FILE = path.join(__dirname, "data", "audit-logs.json.rollbacktest");
const DB_FILE = testHelper.DB_FILE;
const PORT = 3061;
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
      { id: "r_test1", code: "TP-测试-001", source: "测试来源1", paperSize: "30x40cm", note: "测试拓片1", createdAt: new Date().toISOString() },
      { id: "r_test2", code: "TP-测试-002", source: "测试来源2", paperSize: "50x70cm", note: "测试拓片2", createdAt: new Date().toISOString() }
    ],
    damages: [
      { id: "d_test1", rubbingId: "r_test1", position: "左上角", type: "虫蛀孔", beforePhotoUrl: "https://example.com/b1.jpg", afterPhotoUrl: "", status: "in_repair", repairNote: "", batchId: null, reviewStatus: "approved", rejectReason: "", createdAt: new Date().toISOString(), repairedAt: null },
      { id: "d_test2", rubbingId: "r_test1", position: "下边缘中央", type: "撕裂", beforePhotoUrl: "https://example.com/b2.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, reviewStatus: "approved", rejectReason: "", createdAt: new Date().toISOString(), repairedAt: null },
      { id: "d_test3", rubbingId: "r_test2", position: "右上角", type: "霉斑", beforePhotoUrl: "https://example.com/b3.jpg", afterPhotoUrl: "", status: "in_repair", repairNote: "", batchId: null, reviewStatus: "approved", rejectReason: "", createdAt: new Date().toISOString(), repairedAt: null },
      { id: "d_test4", rubbingId: "r_test1", position: "中央区域", type: "风化缺损", beforePhotoUrl: "https://example.com/b4.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, reviewStatus: "approved", rejectReason: "", createdAt: new Date().toISOString(), repairedAt: null }
    ],
    batches: [
      { id: "b_test1", name: "回滚测试批次A", status: "open", damageIds: ["d_test1", "d_test2"], note: "准备完成后回滚", createdAt: new Date().toISOString(), completedAt: null, plannedStartAt: null, plannedEndAt: null, responsible: "测试员" },
      { id: "b_test2", name: "回滚测试批次B", status: "open", damageIds: ["d_test3"], note: "独立批次", createdAt: new Date().toISOString(), completedAt: null, plannedStartAt: null, plannedEndAt: null, responsible: "测试员" },
      { id: "b_test3", name: "旧数据测试批次(无快照)", status: "completed", damageIds: ["d_test4"], note: "模拟旧数据", createdAt: "2025-01-01T00:00:00.000Z", completedAt: "2025-01-02T00:00:00.000Z", plannedStartAt: null, plannedEndAt: null, responsible: "旧管理员" }
    ],
    repairImages: [],
    batchSnapshots: []
  };
  writeDb(testData);
}

async function testScenario1_RepeatComplete() {
  console.log("\n=== 场景1：重复完成同一批次，快照被覆盖 ===");

  const completeRes1 = await httpRequest("POST", "/batches/b_test1/complete", {
    note: "第一次完成",
    defaultAfterPhotoUrl: "https://example.com/default1.jpg",
    defaultRepairNote: "默认修补说明1",
    results: [
      { damageId: "d_test1", afterPhotoUrl: "https://example.com/a1-v1.jpg", repairNote: "第一次修补缺损1" }
    ],
    archiveImages: [
      { damageId: "d_test1", stage: "after_repair", url: "https://example.com/img-v1.jpg", capturedAt: new Date().toISOString() }
    ]
  });
  assertEqual(completeRes1.status, 200, "第一次完成返回 200");
  assertTrue(!!completeRes1.body.snapshotId, "第一次完成返回 snapshotId");
  const snapshotId1 = completeRes1.body.snapshotId;

  const damage1After1 = await httpRequest("GET", "/damages?status=repaired");
  const repaired1 = damage1After1.body.data.find((d) => d.id === "d_test1");
  assertEqual(repaired1.status, "repaired", "第一次完成后 d_test1 状态为 repaired");
  assertEqual(repaired1.repairNote, "第一次修补缺损1", "第一次完成后 d_test1.repairNote 正确");

  await sleep(50);

  const completeRes2 = await httpRequest("POST", "/batches/b_test1/complete", {
    note: "第二次完成(覆盖)",
    defaultAfterPhotoUrl: "https://example.com/default2.jpg",
    defaultRepairNote: "默认修补说明2",
    results: [
      { damageId: "d_test1", afterPhotoUrl: "https://example.com/a1-v2.jpg", repairNote: "第二次修补缺损1" },
      { damageId: "d_test2", afterPhotoUrl: "https://example.com/a2-v2.jpg", repairNote: "第二次修补缺损2" }
    ]
  });
  assertEqual(completeRes2.status, 200, "第二次完成返回 200");
  assertTrue(!!completeRes2.body.snapshotId, "第二次完成返回 snapshotId");
  assertTrue(completeRes2.body.snapshotId !== snapshotId1, "第二次完成 snapshotId 已更新(覆盖)");

  const damage1After2 = await httpRequest("GET", "/damages?status=repaired");
  const repaired1v2 = damage1After2.body.data.find((d) => d.id === "d_test1");
  const repaired2v2 = damage1After2.body.data.find((d) => d.id === "d_test2");
  assertEqual(repaired1v2.repairNote, "第二次修补缺损1", "第二次完成后 d_test1.repairNote 被覆盖");
  assertEqual(repaired2v2.status, "repaired", "第二次完成后 d_test2 状态为 repaired");
  assertEqual(repaired2v2.repairNote, "第二次修补缺损2", "第二次完成后 d_test2.repairNote 正确");
}

async function testScenario2_PartialResults() {
  console.log("\n=== 场景2：部分结果缺失，使用默认值回滚 ===");

  const rollbackRes1 = await httpRequest("POST", "/batches/b_test1/rollback", {});
  assertEqual(rollbackRes1.status, 200, "回滚批次A返回 200");
  assertEqual(rollbackRes1.body.restoredDamageCount, 2, "回滚恢复了 2 个缺损项");

  const damagesAfterRollback1 = await httpRequest("GET", "/damages");
  const d1Rollback = damagesAfterRollback1.body.data.find((d) => d.id === "d_test1");
  const d2Rollback = damagesAfterRollback1.body.data.find((d) => d.id === "d_test2");
  assertEqual(d1Rollback.status, "in_repair", "回滚后 d_test1 恢复到 in_repair");
  assertEqual(d2Rollback.status, "pending", "回滚后 d_test2 恢复到 pending");
  assertEqual(d1Rollback.repairNote, "", "回滚后 d_test1.repairNote 清空");
  assertEqual(d2Rollback.repairNote, "", "回滚后 d_test2.repairNote 清空");
  assertEqual(d1Rollback.repairedAt, null, "回滚后 d_test1.repairedAt 清空");

  const batchA = await httpRequest("GET", "/batches/b_test1");
  assertEqual(batchA.body.data.status, "open", "回滚后批次A状态恢复为 open");
  assertEqual(batchA.body.data.completedAt, null, "回滚后批次A completedAt 清空");

  const completeResPartial = await httpRequest("POST", "/batches/b_test1/complete", {
    note: "部分结果完成",
    defaultAfterPhotoUrl: "https://example.com/default-partial.jpg",
    defaultRepairNote: "默认修补说明(部分结果)"
  });
  assertEqual(completeResPartial.status, 200, "无 results 时使用默认值完成返回 200");

  const damagesPartial = await httpRequest("GET", "/damages?status=repaired");
  const d1Partial = damagesPartial.body.data.find((d) => d.id === "d_test1");
  const d2Partial = damagesPartial.body.data.find((d) => d.id === "d_test2");
  assertEqual(d1Partial.afterPhotoUrl, "https://example.com/default-partial.jpg", "部分结果下 d_test1 使用默认 afterPhotoUrl");
  assertEqual(d2Partial.afterPhotoUrl, "https://example.com/default-partial.jpg", "部分结果下 d_test2 使用默认 afterPhotoUrl");
  assertEqual(d1Partial.repairNote, "默认修补说明(部分结果)", "部分结果下 d_test1 使用默认 repairNote");
  assertEqual(d2Partial.repairNote, "默认修补说明(部分结果)", "部分结果下 d_test2 使用默认 repairNote");

  const rollbackResPartial = await httpRequest("POST", "/batches/b_test1/rollback", {});
  assertEqual(rollbackResPartial.status, 200, "部分结果完成后回滚返回 200");

  const damagesPartialRollback = await httpRequest("GET", "/damages");
  const d1PR = damagesPartialRollback.body.data.find((d) => d.id === "d_test1");
  const d2PR = damagesPartialRollback.body.data.find((d) => d.id === "d_test2");
  assertEqual(d1PR.status, "in_repair", "部分结果回滚后 d_test1 状态正确");
  assertEqual(d2PR.status, "pending", "部分结果回滚后 d_test2 状态正确");
  assertEqual(d1PR.afterPhotoUrl, "", "部分结果回滚后 d_test1.afterPhotoUrl 清空");
  assertEqual(d2PR.afterPhotoUrl, "", "部分结果回滚后 d_test2.afterPhotoUrl 清空");
}

async function testScenario3_RollbackThenComplete() {
  console.log("\n=== 场景3：回滚后再次完成 ===");

  const batchBefore = await httpRequest("GET", "/batches/b_test1");
  assertEqual(batchBefore.body.data.status, "open", "开始前批次A状态为 open");

  const complete1 = await httpRequest("POST", "/batches/b_test1/complete", {
    note: "第一轮完成",
    defaultRepairNote: "第一轮修补"
  });
  assertEqual(complete1.status, 200, "第一轮完成成功");
  const d1c1 = (await httpRequest("GET", "/damages")).body.data.find((d) => d.id === "d_test1");
  assertEqual(d1c1.repairNote, "第一轮修补", "第一轮完成后 repairNote 正确");

  const rollback1 = await httpRequest("POST", "/batches/b_test1/rollback", {});
  assertEqual(rollback1.status, 200, "第一轮回滚成功");
  const d1r1 = (await httpRequest("GET", "/damages")).body.data.find((d) => d.id === "d_test1");
  assertEqual(d1r1.status, "in_repair", "回滚后 d_test1 回到 in_repair");
  assertEqual(d1r1.repairNote, "", "回滚后 repairNote 清空");

  await sleep(50);

  const complete2 = await httpRequest("POST", "/batches/b_test1/complete", {
    note: "第二轮完成(重新完成)",
    results: [
      { damageId: "d_test1", afterPhotoUrl: "https://example.com/recomplete-a1.jpg", repairNote: "第二轮重新修补缺损1" },
      { damageId: "d_test2", afterPhotoUrl: "https://example.com/recomplete-a2.jpg", repairNote: "第二轮重新修补缺损2" }
    ]
  });
  assertEqual(complete2.status, 200, "回滚后再次完成返回 200");
  assertTrue(!!complete2.body.snapshotId, "重新完成后生成新 snapshotId");

  const d1c2 = (await httpRequest("GET", "/damages?status=repaired")).body.data.find((d) => d.id === "d_test1");
  const d2c2 = (await httpRequest("GET", "/damages?status=repaired")).body.data.find((d) => d.id === "d_test2");
  assertEqual(d1c2.repairNote, "第二轮重新修补缺损1", "重新完成后 d_test1.repairNote 正确");
  assertEqual(d2c2.repairNote, "第二轮重新修补缺损2", "重新完成后 d_test2.repairNote 正确");
  assertEqual(d1c2.afterPhotoUrl, "https://example.com/recomplete-a1.jpg", "重新完成后 d_test1.afterPhotoUrl 正确");

  const rollback2 = await httpRequest("POST", "/batches/b_test1/rollback", {});
  assertEqual(rollback2.status, 200, "重新完成后再次回滚成功");

  const finalBatch = await httpRequest("GET", "/batches/b_test1");
  assertEqual(finalBatch.body.data.status, "open", "最终批次A状态为 open");
  const finalDamages = (await httpRequest("GET", "/damages")).body.data;
  assertEqual(finalDamages.find((d) => d.id === "d_test1").status, "in_repair", "最终 d_test1 回到 in_repair");
  assertEqual(finalDamages.find((d) => d.id === "d_test2").status, "pending", "最终 d_test2 回到 pending");
}

async function testScenario4_OldDataNoSnapshot() {
  console.log("\n=== 场景4：旧数据(无快照)回滚返回可理解错误 ===");

  const rollbackRes = await httpRequest("POST", "/batches/b_test3/rollback", {});
  assertEqual(rollbackRes.status, 400, "旧数据回滚返回 400");
  assertEqual(rollbackRes.body.code, "SNAPSHOT_NOT_FOUND", "错误码为 SNAPSHOT_NOT_FOUND");
  assertContains(rollbackRes.body.error, "未找到完成时的快照数据", "错误信息说明缺少快照");
  assertContains(rollbackRes.body.error, "旧数据", "错误信息提到旧数据");
  assertTrue(!!rollbackRes.body.hint, "提供了 hint 字段");
}

async function testScenario5_ReferenceCheck() {
  console.log("\n=== 场景5：后续批次引用缺损项时拒绝回滚 ===");

  const rollbackCleanup = await httpRequest("POST", "/batches/b_test1/rollback", {});

  await sleep(50);
  await httpRequest("POST", "/batches/b_test1/complete", {
    note: "批次A先完成",
    defaultRepairNote: "批次A修补"
  });

  await sleep(50);
  await httpRequest("POST", "/batches/b_test2/complete", {
    note: "批次B后完成",
    defaultRepairNote: "批次B修补"
  });

  const rawDbRaw = fs.readFileSync(DB_FILE, "utf8");
  const rawDb = JSON.parse(rawDbRaw);
  const batches = rawDb.entities ? rawDb.entities.batches : rawDb.batches;
  batches.find((b) => b.id === "b_test2").damageIds.push("d_test1");
  if (rawDb.entities) {
    rawDb.entities.batches = batches;
  } else {
    rawDb.batches = batches;
  }
  const tempFile = DB_FILE + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(rawDb, null, 2));
  fs.renameSync(tempFile, DB_FILE);

  const rollbackBlocked = await httpRequest("POST", "/batches/b_test1/rollback", {});
  assertEqual(rollbackBlocked.status, 409, "被引用时回滚返回 409");
  assertEqual(rollbackBlocked.body.code, "DAMAGE_REFERENCED_BY_LATER_BATCH", "错误码正确");
  assertTrue(Array.isArray(rollbackBlocked.body.referencedBy), "返回 referencedBy 数组");
  assertTrue(rollbackBlocked.body.referencedBy.length >= 1, "referencedBy 至少包含一个后续批次");
  assertContains(rollbackBlocked.body.error, "引用", "错误信息提到引用问题");

  const rawDb2Raw = fs.readFileSync(DB_FILE, "utf8");
  const rawDb2 = JSON.parse(rawDb2Raw);
  const batches2 = rawDb2.entities ? rawDb2.entities.batches : rawDb2.batches;
  batches2.find((b) => b.id === "b_test2").damageIds = ["d_test3"];
  if (rawDb2.entities) {
    rawDb2.entities.batches = batches2;
  } else {
    rawDb2.batches = batches2;
  }
  const tempFile2 = DB_FILE + ".tmp2";
  fs.writeFileSync(tempFile2, JSON.stringify(rawDb2, null, 2));
  fs.renameSync(tempFile2, DB_FILE);

  await sleep(30);
  const rollbackOk = await httpRequest("POST", "/batches/b_test2/rollback", {});
  assertEqual(rollbackOk.status, 200, "解除引用后批次B回滚成功");

  const rollbackAOk = await httpRequest("POST", "/batches/b_test1/rollback", {});
  assertEqual(rollbackAOk.status, 200, "解除引用后批次A回滚成功");
}

async function testScenario6_ArchiveImagesRollback() {
  console.log("\n=== 场景6：归档影像随回滚一起清理 ===");

  const imgBefore = (await httpRequest("GET", "/damages/d_test1/images")).body.data;
  const beforeCount = (imgBefore.before_repair || []).length + (imgBefore.during_repair || []).length + (imgBefore.after_repair || []).length;

  const completeWithImgs = await httpRequest("POST", "/batches/b_test1/complete", {
    note: "带影像完成",
    archiveImages: [
      { damageId: "d_test1", stage: "before_repair", url: "https://example.com/rb-before.jpg", capturedAt: new Date().toISOString() },
      { damageId: "d_test1", stage: "during_repair", url: "https://example.com/rb-during.jpg", capturedAt: new Date().toISOString() },
      { damageId: "d_test1", stage: "after_repair", url: "https://example.com/rb-after.jpg", capturedAt: new Date().toISOString() },
      { damageId: "d_test2", stage: "after_repair", url: "https://example.com/rb-after2.jpg", capturedAt: new Date().toISOString() }
    ]
  });
  assertEqual(completeWithImgs.status, 200, "带影像完成成功");

  const imgAfter = (await httpRequest("GET", "/damages/d_test1/images")).body.data;
  const afterTotal = (imgAfter.before_repair || []).length + (imgAfter.during_repair || []).length + (imgAfter.after_repair || []).length;
  assertTrue(afterTotal >= beforeCount + 3, "d_test1 归档影像数量增加");

  const rollbackImgs = await httpRequest("POST", "/batches/b_test1/rollback", {});
  assertEqual(rollbackImgs.status, 200, "带影像的批次回滚成功");
  assertEqual(rollbackImgs.body.removedImageCount, 4, "回滚报告删除了 4 张影像");

  const imgRollback = (await httpRequest("GET", "/damages/d_test1/images")).body.data;
  const rbCount = imgRollback.after_repair.length;
  assertEqual(rbCount, 0, "回滚后 d_test1 after_repair 影像被清理");
}

async function main() {
  try {
    console.log("批次完成回滚机制端到端验证");
    console.log("=".repeat(50));

    backupDb();
    prepareTestData();
    await startServer();

    await testScenario1_RepeatComplete();
    await testScenario2_PartialResults();
    await testScenario3_RollbackThenComplete();
    await testScenario4_OldDataNoSnapshot();
    await testScenario5_ReferenceCheck();
    await testScenario6_ArchiveImagesRollback();

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
