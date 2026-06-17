const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const testHelper = require("./test-helper");

const BACKUP_FILE = path.join(__dirname, "data", "db.json.testbackup");
const PORT = 3035;
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
    if (body) {
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

async function runTests() {
  console.log("\n=== 批次排程模块测试 ===");

  console.log("\n【场景1】创建带排程信息的批次");
  writeDb({
    rubbings: [
      { id: "r1", code: "TP-清-014", source: "地方碑刻残页", paperSize: "42x68cm", note: "", createdAt: "2026-01-01T00:00:00.000Z" }
    ],
    damages: [
      { id: "d1", rubbingId: "r1", position: "左上角", type: "虫蛀孔", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null },
      { id: "d2", rubbingId: "r1", position: "下边缘", type: "撕裂", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null }
    ],
    batches: []
  });
  await startServer();

  const createRes = await httpRequest("POST", "/batches", {
    name: "六月排程批次",
    damageIds: ["d1", "d2"],
    plannedStartAt: "2026-06-20T09:00:00.000Z",
    plannedEndAt: "2026-06-25T18:00:00.000Z",
    responsible: "张师傅"
  });
  assertEqual(createRes.status, 201, "创建批次返回 201");
  const createdBatch = createRes.body.data;
  assertEqual(createdBatch.name, "六月排程批次", "批次名称正确");
  assertEqual(createdBatch.plannedStartAt, "2026-06-20T09:00:00.000Z", "计划开始时间正确");
  assertEqual(createdBatch.plannedEndAt, "2026-06-25T18:00:00.000Z", "计划完成时间正确");
  assertEqual(createdBatch.responsible, "张师傅", "负责人正确");
  assertEqual(createdBatch.status, "open", "批次状态为 open");
  assert(Array.isArray(createdBatch.damages), "批次包含缺损项详情");

  await stopServer();

  console.log("\n【场景2】同一个缺损项不能被安排进多个未完成批次");
  writeDb({
    rubbings: [
      { id: "r1", code: "TP-清-014", source: "地方碑刻残页", paperSize: "42x68cm", note: "", createdAt: "2026-01-01T00:00:00.000Z" }
    ],
    damages: [
      { id: "d1", rubbingId: "r1", position: "左上角", type: "虫蛀孔", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "in_repair", repairNote: "", batchId: "b1", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null },
      { id: "d2", rubbingId: "r1", position: "下边缘", type: "撕裂", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null }
    ],
    batches: [
      { id: "b1", name: "已有批次", status: "open", damageIds: ["d1"], note: "", createdAt: "2026-06-10T00:00:00.000Z", completedAt: null, plannedStartAt: "2026-06-15T00:00:00.000Z", plannedEndAt: "2026-06-18T00:00:00.000Z", responsible: "李师傅" }
    ]
  });
  await startServer();

  const conflictRes = await httpRequest("POST", "/batches", {
    name: "冲突批次",
    damageIds: ["d1", "d2"],
    plannedStartAt: "2026-06-20T00:00:00.000Z",
    plannedEndAt: "2026-06-25T00:00:00.000Z",
    responsible: "王师傅"
  });
  assertEqual(conflictRes.status, 400, "冲突批次返回 400");
  assert(conflictRes.body.conflictDamageIds.includes("d1"), "返回冲突的缺损项 ID");

  await stopServer();

  console.log("\n【场景3】完成批次后释放排程限制");
  writeDb({
    rubbings: [
      { id: "r1", code: "TP-清-014", source: "地方碑刻残页", paperSize: "42x68cm", note: "", createdAt: "2026-01-01T00:00:00.000Z" }
    ],
    damages: [
      { id: "d1", rubbingId: "r1", position: "左上角", type: "虫蛀孔", beforePhotoUrl: "x.jpg", afterPhotoUrl: "y.jpg", status: "repaired", repairNote: "已修复", batchId: "b1", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: "2026-06-15T00:00:00.000Z" }
    ],
    batches: [
      { id: "b1", name: "已完成批次", status: "completed", damageIds: ["d1"], note: "", createdAt: "2026-06-10T00:00:00.000Z", completedAt: "2026-06-15T00:00:00.000Z", plannedStartAt: "2026-06-12T00:00:00.000Z", plannedEndAt: "2026-06-14T00:00:00.000Z", responsible: "李师傅" }
    ]
  });
  await startServer();

  const afterCompleteRes = await httpRequest("POST", "/batches", {
    name: "新批次",
    damageIds: ["d1"],
    plannedStartAt: "2026-07-01T00:00:00.000Z",
    plannedEndAt: "2026-07-05T00:00:00.000Z",
    responsible: "张师傅"
  });
  assertEqual(afterCompleteRes.status, 201, "已完成批次的缺损项可重新排程");

  await stopServer();

  console.log("\n【场景4】按日期范围查询排程");
  writeDb({
    rubbings: [
      { id: "r1", code: "TP-清-014", source: "地方碑刻残页", paperSize: "42x68cm", note: "", createdAt: "2026-01-01T00:00:00.000Z" }
    ],
    damages: [
      { id: "d1", rubbingId: "r1", position: "左上角", type: "虫蛀孔", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "in_repair", repairNote: "", batchId: "b1", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null },
      { id: "d2", rubbingId: "r1", position: "下边缘", type: "撕裂", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "in_repair", repairNote: "", batchId: "b2", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null },
      { id: "d3", rubbingId: "r1", position: "右上角", type: "水渍", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "in_repair", repairNote: "", batchId: "b3", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null },
      { id: "d4", rubbingId: "r1", position: "左下角", type: "霉斑", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "in_repair", repairNote: "", batchId: "b4", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null }
    ],
    batches: [
      { id: "b1", name: "六月上旬批次", status: "open", damageIds: ["d1"], note: "", createdAt: "2026-06-01T00:00:00.000Z", completedAt: null, plannedStartAt: "2026-06-05T00:00:00.000Z", plannedEndAt: "2026-06-10T00:00:00.000Z", responsible: "张师傅" },
      { id: "b2", name: "六月中旬批次", status: "open", damageIds: ["d2"], note: "", createdAt: "2026-06-01T00:00:00.000Z", completedAt: null, plannedStartAt: "2026-06-15T00:00:00.000Z", plannedEndAt: "2026-06-20T00:00:00.000Z", responsible: "李师傅" },
      { id: "b3", name: "七月批次", status: "open", damageIds: ["d3"], note: "", createdAt: "2026-06-01T00:00:00.000Z", completedAt: null, plannedStartAt: "2026-07-01T00:00:00.000Z", plannedEndAt: "2026-07-05T00:00:00.000Z", responsible: "王师傅" },
      { id: "b4", name: "六月月末批次", status: "open", damageIds: ["d4"], note: "", createdAt: "2026-06-01T00:00:00.000Z", completedAt: null, plannedStartAt: "2026-06-30T09:00:00.000Z", plannedEndAt: "2026-06-30T18:00:00.000Z", responsible: "赵师傅" }
    ]
  });
  await startServer();

  const juneScheduleRes = await httpRequest("GET", "/schedules?startDate=2026-06-01&endDate=2026-06-30");
  assertEqual(juneScheduleRes.status, 200, "六月排程查询返回 200");
  assertEqual(juneScheduleRes.body.total, 3, "六月范围内有 3 个排程");
  assert(juneScheduleRes.body.data.some((b) => b.name === "六月上旬批次"), "包含六月上旬批次");
  assert(juneScheduleRes.body.data.some((b) => b.name === "六月中旬批次"), "包含六月中旬批次");
  assert(juneScheduleRes.body.data.some((b) => b.name === "六月月末批次"), "包含六月月末批次");
  assert(!juneScheduleRes.body.data.some((b) => b.name === "七月批次"), "不包含七月批次");
  assertEqual(juneScheduleRes.body.data[0].name, "六月上旬批次", "排程按开始时间升序排列");

  const midJuneRes = await httpRequest("GET", "/schedules?startDate=2026-06-12&endDate=2026-06-18");
  assertEqual(midJuneRes.body.total, 1, "6月12-18日范围内有 1 个排程");
  assertEqual(midJuneRes.body.data[0].name, "六月中旬批次", "正确匹配中旬批次");

  await stopServer();

  console.log("\n【场景5】按状态筛选排程");
  writeDb({
    rubbings: [
      { id: "r1", code: "TP-清-014", source: "地方碑刻残页", paperSize: "42x68cm", note: "", createdAt: "2026-01-01T00:00:00.000Z" }
    ],
    damages: [
      { id: "d1", rubbingId: "r1", position: "左上角", type: "虫蛀孔", beforePhotoUrl: "x.jpg", afterPhotoUrl: "y.jpg", status: "repaired", repairNote: "", batchId: "b1", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: "2026-06-15T00:00:00.000Z" },
      { id: "d2", rubbingId: "r1", position: "下边缘", type: "撕裂", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "in_repair", repairNote: "", batchId: "b2", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null }
    ],
    batches: [
      { id: "b1", name: "已完成批次", status: "completed", damageIds: ["d1"], note: "", createdAt: "2026-06-01T00:00:00.000Z", completedAt: "2026-06-15T00:00:00.000Z", plannedStartAt: "2026-06-10T00:00:00.000Z", plannedEndAt: "2026-06-14T00:00:00.000Z", responsible: "张师傅" },
      { id: "b2", name: "进行中批次", status: "open", damageIds: ["d2"], note: "", createdAt: "2026-06-01T00:00:00.000Z", completedAt: null, plannedStartAt: "2026-06-20T00:00:00.000Z", plannedEndAt: "2026-06-25T00:00:00.000Z", responsible: "李师傅" }
    ]
  });
  await startServer();

  const openScheduleRes = await httpRequest("GET", "/schedules?startDate=2026-06-01&endDate=2026-06-30&status=open");
  assertEqual(openScheduleRes.body.total, 1, "筛选 open 状态返回 1 个");
  assertEqual(openScheduleRes.body.data[0].name, "进行中批次", "正确返回进行中批次");

  const completedScheduleRes = await httpRequest("GET", "/schedules?startDate=2026-06-01&endDate=2026-06-30&status=completed");
  assertEqual(completedScheduleRes.body.total, 1, "筛选 completed 状态返回 1 个");
  assertEqual(completedScheduleRes.body.data[0].name, "已完成批次", "正确返回已完成批次");

  await stopServer();

  console.log("\n【场景6】旧数据兼容（无排程字段的旧批次）");
  writeDb({
    rubbings: [
      { id: "r1", code: "TP-清-014", source: "地方碑刻残页", paperSize: "42x68cm", note: "", createdAt: "2026-01-01T00:00:00.000Z" }
    ],
    damages: [
      { id: "d1", rubbingId: "r1", position: "左上角", type: "虫蛀孔", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "in_repair", repairNote: "", batchId: "b1", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null }
    ],
    batches: [
      { id: "b1", name: "旧格式批次", status: "open", damageIds: ["d1"], note: "", createdAt: "2026-06-01T00:00:00.000Z", completedAt: null }
    ]
  });
  await startServer();

  const batchesRes = await httpRequest("GET", "/batches");
  assertEqual(batchesRes.status, 200, "查询批次列表返回 200");
  const oldBatch = batchesRes.body.data.find((b) => b.id === "b1");
  assert(oldBatch !== undefined, "旧批次存在");
  assertEqual(oldBatch.plannedStartAt, null, "旧批次 plannedStartAt 默认为 null");
  assertEqual(oldBatch.plannedEndAt, null, "旧批次 plannedEndAt 默认为 null");
  assertEqual(oldBatch.responsible, null, "旧批次 responsible 默认为 null");

  const batchDetailRes = await httpRequest("GET", "/batches/b1");
  assertEqual(batchDetailRes.status, 200, "查询批次详情返回 200");
  assertEqual(batchDetailRes.body.data.plannedStartAt, null, "详情页旧数据默认 null");

  const scheduleWithoutPlannedRes = await httpRequest("GET", "/schedules?startDate=2026-06-01&endDate=2026-06-30");
  assertEqual(scheduleWithoutPlannedRes.body.total, 0, "无计划时间的批次不出现在排程查询中");

  const batchByIdRes = await httpRequest("GET", "/batches/b1");
  assertEqual(batchByIdRes.status, 200, "GET /batches/:id 兼容旧数据");

  await stopServer();

  console.log("\n【场景7】无效日期参数处理");
  await startServer();

  const missingDateRes = await httpRequest("GET", "/schedules");
  assertEqual(missingDateRes.status, 400, "缺少日期参数返回 400");

  const invalidDateRes = await httpRequest("GET", "/schedules?startDate=invalid&endDate=2026-06-30");
  assertEqual(invalidDateRes.status, 400, "无效日期格式返回 400");

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
    await runTests();
  } catch (err) {
    console.error("\n❌ 测试执行出错:", err.message);
    process.exit(1);
  } finally {
    await stopServer();
    restoreDb();
  }
}

main();
