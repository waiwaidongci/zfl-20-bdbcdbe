const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const testHelper = require("./test-helper");

const BACKUP_FILE = path.join(__dirname, "data", "db.json.testbackup");
const PORT = 3037;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let server;
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
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode,
            body: data ? JSON.parse(data) : null
          });
        } catch (e) {
          resolve({
            status: res.statusCode,
            body: data
          });
        }
      });
    });
    req.on("error", reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ PASS: ${message}`);
  } else {
    failed += 1;
    console.log(`  ✗ FAIL: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed += 1;
    console.log(`  ✓ PASS: ${message}`);
  } else {
    failed += 1;
    console.log(`  ✗ FAIL: ${message}`);
    console.log(`    期望: ${JSON.stringify(expected)}`);
    console.log(`    实际: ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(str, substr, message) {
  if (str && str.includes && str.includes(substr)) {
    passed += 1;
    console.log(`  ✓ PASS: ${message}`);
  } else {
    failed += 1;
    console.log(`  ✗ FAIL: ${message}`);
    console.log(`    期望包含: "${substr}"`);
    console.log(`    实际: "${str}"`);
  }
}

async function runTests() {
  console.log("\n部分回滚后排程闭环验证");
  console.log("=".repeat(50));

  console.log("\n=== 场景1：部分回滚后，已回滚的缺损可重新排程到新批次 ===");
  writeDb({
    rubbings: [
      { id: "r_sch1", code: "TP-清-001", source: "地方碑刻残页", paperSize: "42x68cm", note: "", createdAt: "2026-01-01T00:00:00.000Z" }
    ],
    damages: [
      { id: "d_sch1", rubbingId: "r_sch1", position: "左上角", type: "虫蛀孔", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, reviewStatus: "approved", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null },
      { id: "d_sch2", rubbingId: "r_sch1", position: "下边缘", type: "撕裂", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, reviewStatus: "approved", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null }
    ],
    batches: [],
    repairImages: [],
    batchSnapshots: [],
    auditLogs: []
  });
  await startServer();

  let createRes = await httpRequest("POST", "/batches", {
    name: "原始批次",
    damageIds: ["d_sch1", "d_sch2"]
  });
  assertEqual(createRes.status, 201, "创建原始批次返回 201");
  const batchId1 = createRes.body.data.id;

  let completeRes = await httpRequest("POST", `/batches/${batchId1}/complete`, {
    results: [
      { damageId: "d_sch1", afterPhotoUrl: "https://example.com/a1.jpg", repairNote: "修补完成1" },
      { damageId: "d_sch2", afterPhotoUrl: "https://example.com/a2.jpg", repairNote: "修补完成2" }
    ]
  });
  assertEqual(completeRes.status, 200, "完成原始批次返回 200");

  let damages = (await httpRequest("GET", "/damages")).body.data;
  let damage1 = damages.find((d) => d.id === "d_sch1");
  let damage2 = damages.find((d) => d.id === "d_sch2");
  assertEqual(damage1.batchId, batchId1, "完成后 d_sch1 的 batchId 正确");
  assertEqual(damage1.status, "repaired", "完成后 d_sch1 状态为 repaired");

  let partialRollbackRes = await httpRequest("POST", `/batches/${batchId1}/rollback`, {
    damageIds: ["d_sch1"]
  });
  assertEqual(partialRollbackRes.status, 200, "部分回滚 d_sch1 返回 200");
  assertEqual(partialRollbackRes.body.batchStatus, "partially_rolled_back", "批次状态为 partially_rolled_back");

  damages = (await httpRequest("GET", "/damages")).body.data;
  damage1 = damages.find((d) => d.id === "d_sch1");
  damage2 = damages.find((d) => d.id === "d_sch2");
  assertEqual(damage1.batchId, null, "部分回滚后 d_sch1 的 batchId 已清空");
  assertEqual(damage1.status, "in_repair", "部分回滚后 d_sch1 状态为 in_repair");
  assertEqual(damage2.batchId, batchId1, "部分回滚后 d_sch2 的 batchId 仍正确");
  assertEqual(damage2.status, "repaired", "部分回滚后 d_sch2 状态保持 repaired");

  let newBatchRes = await httpRequest("POST", "/batches", {
    name: "新批次",
    damageIds: ["d_sch1"]
  });
  assertEqual(newBatchRes.status, 201, "已回滚的 d_sch1 可添加到新批次");

  let newBatch2Res = await httpRequest("POST", "/batches", {
    name: "冲突批次",
    damageIds: ["d_sch2"]
  });
  assertEqual(newBatch2Res.status, 400, "未回滚的 d_sch2 不能添加到新批次");
  assert(newBatch2Res.body.conflictDamageIds.includes("d_sch2"), "返回冲突的缺损项 ID");

  await stopServer();

  console.log("\n=== 场景2：部分回滚后全部回滚，所有缺损可重新排程 ===");
  writeDb({
    rubbings: [
      { id: "r_sch3", code: "TP-清-003", source: "地方碑刻残页", paperSize: "42x68cm", note: "", createdAt: "2026-01-01T00:00:00.000Z" }
    ],
    damages: [
      { id: "d_sch3", rubbingId: "r_sch3", position: "左上角", type: "虫蛀孔", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, reviewStatus: "approved", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null },
      { id: "d_sch4", rubbingId: "r_sch3", position: "下边缘", type: "撕裂", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, reviewStatus: "approved", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null }
    ],
    batches: [],
    repairImages: [],
    batchSnapshots: [],
    auditLogs: []
  });
  await startServer();

  createRes = await httpRequest("POST", "/batches", {
    name: "原始批次2",
    damageIds: ["d_sch3", "d_sch4"]
  });
  assertEqual(createRes.status, 201, "创建原始批次返回 201");
  const batchId3 = createRes.body.data.id;

  completeRes = await httpRequest("POST", `/batches/${batchId3}/complete`, {
    results: [
      { damageId: "d_sch3", afterPhotoUrl: "https://example.com/a3.jpg", repairNote: "修补完成3" },
      { damageId: "d_sch4", afterPhotoUrl: "https://example.com/a4.jpg", repairNote: "修补完成4" }
    ]
  });
  assertEqual(completeRes.status, 200, "完成原始批次返回 200");

  partialRollbackRes = await httpRequest("POST", `/batches/${batchId3}/rollback`, {
    damageIds: ["d_sch3"]
  });
  assertEqual(partialRollbackRes.status, 200, "部分回滚 d_sch3 返回 200");

  let fullRollbackRes = await httpRequest("POST", `/batches/${batchId3}/rollback`);
  assertEqual(fullRollbackRes.status, 200, "从 partially_rolled_back 完整回滚返回 200");

  damages = (await httpRequest("GET", "/damages")).body.data;
  damage1 = damages.find((d) => d.id === "d_sch3");
  damage2 = damages.find((d) => d.id === "d_sch4");
  assertEqual(damage1.batchId, null, "完整回滚后 d_sch3 的 batchId 已清空");
  damage2 = damages.find((d) => d.id === "d_sch4");
  assertEqual(damage2.batchId, null, "完整回滚后 d_sch4 的 batchId 已清空");

  newBatchRes = await httpRequest("POST", "/batches", {
    name: "新批次3",
    damageIds: ["d_sch3", "d_sch4"]
  });
  assertEqual(newBatchRes.status, 201, "完整回滚后所有缺损可重新排程");

  await stopServer();

  console.log("\n=== 场景3：部分回滚后重新完成，缺损 batchId 被重新设置 ===");
  writeDb({
    rubbings: [
      { id: "r_sch5", code: "TP-清-005", source: "地方碑刻残页", paperSize: "42x68cm", note: "", createdAt: "2026-01-01T00:00:00.000Z" }
    ],
    damages: [
      { id: "d_sch5", rubbingId: "r_sch5", position: "左上角", type: "虫蛀孔", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, reviewStatus: "approved", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null },
      { id: "d_sch6", rubbingId: "r_sch5", position: "下边缘", type: "撕裂", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, reviewStatus: "approved", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null }
    ],
    batches: [],
    repairImages: [],
    batchSnapshots: [],
    auditLogs: []
  });
  await startServer();

  createRes = await httpRequest("POST", "/batches", {
    name: "原始批次5",
    damageIds: ["d_sch5", "d_sch6"]
  });
  assertEqual(createRes.status, 201, "创建原始批次返回 201");
  const batchId5 = createRes.body.data.id;

  completeRes = await httpRequest("POST", `/batches/${batchId5}/complete`, {
    results: [
      { damageId: "d_sch5", afterPhotoUrl: "https://example.com/a5.jpg", repairNote: "修补完成5" },
      { damageId: "d_sch6", afterPhotoUrl: "https://example.com/a6.jpg", repairNote: "修补完成6" }
    ]
  });
  assertEqual(completeRes.status, 200, "完成原始批次返回 200");

  partialRollbackRes = await httpRequest("POST", `/batches/${batchId5}/rollback`, {
    damageIds: ["d_sch5"]
  });
  assertEqual(partialRollbackRes.status, 200, "部分回滚 d_sch5 返回 200");

  damages = (await httpRequest("GET", "/damages")).body.data;
  damage1 = damages.find((d) => d.id === "d_sch5");
  damage2 = damages.find((d) => d.id === "d_sch6");
  assertEqual(damage1.batchId, null, "部分回滚后 d_sch5 的 batchId 已清空");
  damage2 = damages.find((d) => d.id === "d_sch6");
  assertEqual(damage2.batchId, batchId5, "部分回滚后 d_sch6 的 batchId 仍正确");

  completeRes = await httpRequest("POST", `/batches/${batchId5}/complete`, {
    results: [
      { damageId: "d_sch5", afterPhotoUrl: "https://example.com/a5_new.jpg", repairNote: "重新修补完成5" }
    ]
  });
  assertEqual(completeRes.status, 200, "重新完成批次返回 200");

  damages = (await httpRequest("GET", "/damages")).body.data;
  damage1 = damages.find((d) => d.id === "d_sch5");
  assertEqual(damage1.batchId, batchId5, "重新完成后 d_sch5 的 batchId 被重新设置");
  assertEqual(damage1.status, "repaired", "重新完成后 d_sch5 状态为 repaired");

  let batchStatus = (await httpRequest("GET", `/batches/${batchId5}`)).body.data.status;
  assertEqual(batchStatus, "completed", "重新完成后批次状态为 completed");

  newBatchRes = await httpRequest("POST", "/batches", {
    name: "新批次5",
    damageIds: ["d_sch5"]
  });
  assertEqual(newBatchRes.status, 201, "批次完成后 d_sch5 可添加到新批次（原批次已完成）");

  await stopServer();

  console.log("\n=== 场景4：连续部分回滚直到全部回滚，所有缺损可重新排程 ===");
  writeDb({
    rubbings: [
      { id: "r_sch7", code: "TP-清-007", source: "地方碑刻残页", paperSize: "42x68cm", note: "", createdAt: "2026-01-01T00:00:00.000Z" }
    ],
    damages: [
      { id: "d_sch7", rubbingId: "r_sch7", position: "左上角", type: "虫蛀孔", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, reviewStatus: "approved", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null },
      { id: "d_sch8", rubbingId: "r_sch7", position: "下边缘", type: "撕裂", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, reviewStatus: "approved", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null }
    ],
    batches: [],
    repairImages: [],
    batchSnapshots: [],
    auditLogs: []
  });
  await startServer();

  createRes = await httpRequest("POST", "/batches", {
    name: "原始批次7",
    damageIds: ["d_sch7", "d_sch8"]
  });
  assertEqual(createRes.status, 201, "创建原始批次返回 201");
  const batchId7 = createRes.body.data.id;

  completeRes = await httpRequest("POST", `/batches/${batchId7}/complete`, {
    results: [
      { damageId: "d_sch7", afterPhotoUrl: "https://example.com/a7.jpg", repairNote: "修补完成7" },
      { damageId: "d_sch8", afterPhotoUrl: "https://example.com/a8.jpg", repairNote: "修补完成8" }
    ]
  });
  assertEqual(completeRes.status, 200, "完成原始批次返回 200");

  partialRollbackRes = await httpRequest("POST", `/batches/${batchId7}/rollback`, {
    damageIds: ["d_sch7"]
  });
  assertEqual(partialRollbackRes.status, 200, "第一次部分回滚 d_sch7 返回 200");
  assertEqual(partialRollbackRes.body.batchStatus, "partially_rolled_back", "批次状态为 partially_rolled_back");

  partialRollbackRes = await httpRequest("POST", `/batches/${batchId7}/rollback`, {
    damageIds: ["d_sch8"]
  });
  assertEqual(partialRollbackRes.status, 200, "第二次部分回滚 d_sch8 返回 200");
  assertEqual(partialRollbackRes.body.batchStatus, "open", "所有缺损回滚后批次状态为 open");

  damages = (await httpRequest("GET", "/damages")).body.data;
  damage1 = damages.find((d) => d.id === "d_sch7");
  damage2 = damages.find((d) => d.id === "d_sch8");
  assertEqual(damage1.batchId, null, "全部回滚后 d_sch7 的 batchId 已清空");
  damage2 = damages.find((d) => d.id === "d_sch8");
  assertEqual(damage2.batchId, null, "全部回滚后 d_sch8 的 batchId 已清空");

  newBatchRes = await httpRequest("POST", "/batches", {
    name: "新批次7",
    damageIds: ["d_sch7", "d_sch8"]
  });
  assertEqual(newBatchRes.status, 201, "全部回滚后所有缺损可重新排程");

  await stopServer();

  console.log("\n" + "=".repeat(50));
  console.log(`测试结果: 通过 ${passed} / ${passed + failed}`);
  if (failed > 0) {
    console.log(`失败 ${failed} 个用例`);
    process.exit(1);
  } else {
    console.log("全部通过 ✓");
  }
}

backupDb();
runTests()
  .catch((err) => {
    console.error("测试执行出错:", err.message);
    process.exit(1);
  })
  .finally(() => {
    restoreDb();
    stopServer().catch(() => {});
  });
