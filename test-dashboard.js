const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const testHelper = require("./test-helper");

const BACKUP_FILE = path.join(__dirname, "data", "db.json.backup");
const PORT = 3021;
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

function request(pathname) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${pathname}`;
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
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
  console.log("\n=== 修补工作台看板接口验证 ===");

  console.log("\n【场景1】空数据");
  writeDb({ rubbings: [], damages: [], batches: [] });
  await startServer();
  const emptyRes = await request("/dashboard/repair-workbench");
  assertEqual(emptyRes.status, 200, "接口返回 200");
  const emptyData = emptyRes.body.data;
  assertEqual(emptyData.statusCounts.pending, 0, "待修补数量为 0");
  assertEqual(emptyData.statusCounts.in_repair, 0, "修补中数量为 0");
  assertEqual(emptyData.statusCounts.repaired, 0, "已完成数量为 0");
  assertEqual(emptyData.statusCounts.total, 0, "总数量为 0");
  assertEqual(emptyData.byType.length, 0, "类型聚合为空数组");
  assertEqual(emptyData.totalTypes, 0, "类型总数为 0");
  assertEqual(emptyData.activeBatches, 0, "进行中批次为 0");
  assertEqual(emptyData.completedBatches, 0, "已完成批次为 0");
  await stopServer();

  console.log("\n【场景2】示例数据（2条 pending 缺损）");
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
  const sampleRes = await request("/dashboard/repair-workbench");
  const sampleData = sampleRes.body.data;
  assertEqual(sampleData.statusCounts.pending, 2, "待修补数量为 2");
  assertEqual(sampleData.statusCounts.in_repair, 0, "修补中数量为 0");
  assertEqual(sampleData.statusCounts.repaired, 0, "已完成数量为 0");
  assertEqual(sampleData.statusCounts.total, 2, "总数量为 2");
  assertEqual(sampleData.byType.length, 2, "类型聚合有 2 种类型");
  assertEqual(sampleData.totalTypes, 2, "类型总数为 2");
  assert(sampleData.byType.some((t) => t.type === "虫蛀孔" && t.total === 1 && t.pending === 1), "虫蛀孔类型统计正确");
  assert(sampleData.byType.some((t) => t.type === "撕裂" && t.total === 1 && t.pending === 1), "撕裂类型统计正确");
  await stopServer();

  console.log("\n【场景3】混合状态（pending + in_repair + repaired）");
  writeDb({
    rubbings: [
      { id: "r1", code: "TP-清-014", source: "西安碑林", paperSize: "60x90cm", note: "", createdAt: "2026-01-01T00:00:00.000Z" }
    ],
    damages: [
      { id: "d1", rubbingId: "r1", position: "左上", type: "虫蛀孔", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null },
      { id: "d2", rubbingId: "r1", position: "右上", type: "虫蛀孔", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "in_repair", repairNote: "", batchId: "b1", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null },
      { id: "d3", rubbingId: "r1", position: "左下", type: "撕裂", beforePhotoUrl: "x.jpg", afterPhotoUrl: "y.jpg", status: "repaired", repairNote: "修补完成", batchId: "b1", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: "2026-01-02T00:00:00.000Z" },
      { id: "d4", rubbingId: "r1", position: "右下", type: "水渍", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "in_repair", repairNote: "", batchId: "b2", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null },
      { id: "d5", rubbingId: "r1", position: "中部", type: "霉斑", beforePhotoUrl: "x.jpg", afterPhotoUrl: "y.jpg", status: "repaired", repairNote: "", batchId: "b2", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: "2026-01-03T00:00:00.000Z" }
    ],
    batches: [
      { id: "b1", name: "第一批", status: "open", damageIds: ["d2", "d3"], note: "", createdAt: "2026-01-01T00:00:00.000Z", completedAt: null },
      { id: "b2", name: "第二批", status: "completed", damageIds: ["d4", "d5"], note: "", createdAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-03T00:00:00.000Z" }
    ]
  });
  await startServer();
  const mixedRes = await request("/dashboard/repair-workbench");
  const mixedData = mixedRes.body.data;
  assertEqual(mixedData.statusCounts.pending, 1, "待修补数量为 1");
  assertEqual(mixedData.statusCounts.in_repair, 2, "修补中数量为 2");
  assertEqual(mixedData.statusCounts.repaired, 2, "已完成数量为 2");
  assertEqual(mixedData.statusCounts.total, 5, "总数量为 5");
  assertEqual(mixedData.totalTypes, 4, "类型总数为 4");
  assertEqual(mixedData.activeBatches, 1, "进行中批次为 1");
  assertEqual(mixedData.completedBatches, 1, "已完成批次为 1");
  assert(mixedData.byType[0].total >= mixedData.byType[mixedData.byType.length - 1].total, "类型按总数降序排列");
  assert(mixedData.byType.find((t) => t.type === "虫蛀孔").total === 2, "虫蛀孔总数为 2");
  assert(mixedData.byType.find((t) => t.type === "虫蛀孔").pending === 1, "虫蛀孔待修补 1");
  assert(mixedData.byType.find((t) => t.type === "虫蛀孔").in_repair === 1, "虫蛀孔修补中 1");
  assert(mixedData.byType.find((t) => t.type === "虫蛀孔").repaired === 0, "虫蛀孔已完成 0");
  await stopServer();

  console.log("\n【场景4】按类型筛选");
  await startServer();
  const typeFilterRes = await request("/dashboard/repair-workbench?type=虫蛀孔");
  const typeFilterData = typeFilterRes.body.data;
  assertEqual(typeFilterData.statusCounts.total, 2, "筛选后总数为 2");
  assertEqual(typeFilterData.statusCounts.pending, 1, "筛选后待修补 1");
  assertEqual(typeFilterData.statusCounts.in_repair, 1, "筛选后修补中 1");
  assertEqual(typeFilterData.byType.length, 1, "筛选后类型聚合仅 1 种");
  assertEqual(typeFilterData.byType[0].type, "虫蛀孔", "筛选后类型为虫蛀孔");
  assertEqual(typeFilterData.totalTypes, 1, "筛选后类型总数为 1");
  await stopServer();

  console.log("\n【场景5】按拓片筛选（与单拓片关联）");
  writeDb({
    rubbings: [
      { id: "r1", code: "TP-清-014", source: "西安碑林", paperSize: "60x90cm", note: "", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "r2", code: "TP-宋-001", source: "故宫藏", paperSize: "50x70cm", note: "", createdAt: "2026-01-01T00:00:00.000Z" }
    ],
    damages: [
      { id: "d1", rubbingId: "r1", position: "左上", type: "虫蛀孔", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null },
      { id: "d2", rubbingId: "r1", position: "右上", type: "撕裂", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null },
      { id: "d3", rubbingId: "r2", position: "中部", type: "水渍", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null }
    ],
    batches: []
  });
  await startServer();
  const rubbingFilterRes = await request("/dashboard/repair-workbench?rubbingId=r1");
  const rubbingFilterData = rubbingFilterRes.body.data;
  assertEqual(rubbingFilterData.statusCounts.total, 2, "按拓片筛选后总数为 2");
  assert(rubbingFilterData.byType.some((t) => t.type === "虫蛀孔"), "筛选后包含虫蛀孔类型");
  assert(rubbingFilterData.byType.some((t) => t.type === "撕裂"), "筛选后包含撕裂类型");
  assert(!rubbingFilterData.byType.some((t) => t.type === "水渍"), "筛选后不包含水渍类型");
  await stopServer();

  console.log("\n【场景6】按批次筛选");
  writeDb({
    rubbings: [
      { id: "r1", code: "TP-清-014", source: "西安碑林", paperSize: "60x90cm", note: "", createdAt: "2026-01-01T00:00:00.000Z" }
    ],
    damages: [
      { id: "d1", rubbingId: "r1", position: "左上", type: "虫蛀孔", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "in_repair", repairNote: "", batchId: "b1", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null },
      { id: "d2", rubbingId: "r1", position: "右上", type: "撕裂", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "in_repair", repairNote: "", batchId: "b1", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null },
      { id: "d3", rubbingId: "r1", position: "左下", type: "霉斑", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null }
    ],
    batches: [
      { id: "b1", name: "第一批", status: "open", damageIds: ["d1", "d2"], note: "", createdAt: "2026-01-01T00:00:00.000Z", completedAt: null }
    ]
  });
  await startServer();
  const batchFilterRes = await request("/dashboard/repair-workbench?batchId=b1");
  const batchFilterData = batchFilterRes.body.data;
  assertEqual(batchFilterData.statusCounts.total, 2, "按批次筛选后总数为 2");
  assertEqual(batchFilterData.statusCounts.in_repair, 2, "按批次筛选后修补中 2");
  assertEqual(batchFilterData.statusCounts.pending, 0, "按批次筛选后待修补 0");
  assertEqual(batchFilterData.activeBatches, 1, "按批次筛选后进行中批次为 1");
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
