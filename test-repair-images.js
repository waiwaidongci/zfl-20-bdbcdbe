const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const testHelper = require("./test-helper");

const BACKUP_FILE = path.join(__dirname, "data", "db.json.imgtestbackup");
const PORT = 3040;
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

function seedDb() {
  writeDb({
    rubbings: [
      { id: "r1", code: "TP-清-014", source: "地方碑刻残页", paperSize: "42x68cm", note: "", createdAt: "2026-01-01T00:00:00.000Z" }
    ],
    damages: [
      { id: "d1", rubbingId: "r1", position: "左上角", type: "虫蛀孔", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "in_repair", repairNote: "", batchId: "b1", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null, reviewStatus: "approved", rejectReason: "" },
      { id: "d2", rubbingId: "r1", position: "下边缘", type: "撕裂", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "in_repair", repairNote: "", batchId: "b1", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null, reviewStatus: "approved", rejectReason: "" }
    ],
    batches: [
      { id: "b1", name: "六月修补批次", status: "open", damageIds: ["d1", "d2"], note: "", createdAt: "2026-06-01T00:00:00.000Z", completedAt: null, plannedStartAt: "2026-06-10T00:00:00.000Z", plannedEndAt: "2026-06-15T00:00:00.000Z", responsible: "张师傅" }
    ],
    repairImages: []
  });
}

async function runTests() {
  console.log("\n=== 修补影像归档模块测试 ===");

  console.log("\n【场景1】为缺损项登记单张影像");
  seedDb();
  await startServer();

  const singleRes = await httpRequest("POST", "/damages/d1/images", {
    stage: "before_repair",
    url: "https://example.local/before-d1-1.jpg",
    capturedAt: "2026-06-10T09:00:00.000Z",
    description: "修补前左上角虫蛀孔",
    collector: "张师傅"
  });
  assertEqual(singleRes.status, 201, "登记影像返回 201");
  const singleImg = singleRes.body.data[0];
  assert(singleImg.id.startsWith("img_"), "影像记录 ID 以 img_ 开头");
  assertEqual(singleImg.damageId, "d1", "影像记录关联缺损项 d1");
  assertEqual(singleImg.stage, "before_repair", "阶段为 before_repair");
  assertEqual(singleImg.url, "https://example.local/before-d1-1.jpg", "URL 正确");
  assertEqual(singleImg.capturedAt, "2026-06-10T09:00:00.000Z", "拍摄时间正确");
  assertEqual(singleImg.description, "修补前左上角虫蛀孔", "说明正确");
  assertEqual(singleImg.collector, "张师傅", "采集人正确");

  await stopServer();

  console.log("\n【场景2】批量登记多张不同阶段影像");
  seedDb();
  await startServer();

  const batchRes = await httpRequest("POST", "/damages/d1/images", {
    images: [
      { stage: "before_repair", url: "https://example.local/before-d1-1.jpg", capturedAt: "2026-06-10T09:00:00.000Z", description: "修补前全景", collector: "张师傅" },
      { stage: "before_repair", url: "https://example.local/before-d1-2.jpg", capturedAt: "2026-06-10T09:05:00.000Z", description: "修补前特写", collector: "张师傅" },
      { stage: "during_repair", url: "https://example.local/during-d1-1.jpg", capturedAt: "2026-06-11T14:00:00.000Z", description: "修补进行中", collector: "李师傅" },
      { stage: "after_repair", url: "https://example.local/after-d1-1.jpg", capturedAt: "2026-06-12T16:00:00.000Z", description: "修补后效果", collector: "李师傅" }
    ]
  });
  assertEqual(batchRes.status, 201, "批量登记影像返回 201");
  assertEqual(batchRes.body.data.length, 4, "返回 4 条影像记录");
  assert(batchRes.body.data.every((img) => img.damageId === "d1"), "所有影像关联缺损项 d1");

  await stopServer();

  console.log("\n【场景3】查询缺损项影像按阶段分组");
  seedDb();
  writeDb({
    rubbings: [
      { id: "r1", code: "TP-清-014", source: "地方碑刻残页", paperSize: "42x68cm", note: "", createdAt: "2026-01-01T00:00:00.000Z" }
    ],
    damages: [
      { id: "d1", rubbingId: "r1", position: "左上角", type: "虫蛀孔", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "in_repair", repairNote: "", batchId: "b1", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null, reviewStatus: "approved", rejectReason: "" }
    ],
    batches: [],
    repairImages: [
      { id: "img_1", damageId: "d1", stage: "before_repair", url: "https://example.local/b1.jpg", capturedAt: "2026-06-10T09:00:00.000Z", description: "修补前1", collector: "张师傅", createdAt: "2026-06-10T09:00:00.000Z" },
      { id: "img_2", damageId: "d1", stage: "before_repair", url: "https://example.local/b2.jpg", capturedAt: "2026-06-10T09:05:00.000Z", description: "修补前2", collector: "张师傅", createdAt: "2026-06-10T09:05:00.000Z" },
      { id: "img_3", damageId: "d1", stage: "during_repair", url: "https://example.local/d1.jpg", capturedAt: "2026-06-11T14:00:00.000Z", description: "修补中1", collector: "李师傅", createdAt: "2026-06-11T14:00:00.000Z" },
      { id: "img_4", damageId: "d1", stage: "after_repair", url: "https://example.local/a1.jpg", capturedAt: "2026-06-12T16:00:00.000Z", description: "修补后1", collector: "李师傅", createdAt: "2026-06-12T16:00:00.000Z" }
    ]
  });
  await startServer();

  const getImagesRes = await httpRequest("GET", "/damages/d1/images");
  assertEqual(getImagesRes.status, 200, "查询影像返回 200");
  const grouped = getImagesRes.body.data;
  assertEqual(grouped.before_repair.length, 2, "修补前影像 2 张");
  assertEqual(grouped.during_repair.length, 1, "修补中影像 1 张");
  assertEqual(grouped.after_repair.length, 1, "修补后影像 1 张");
  assert(grouped.before_repair.every((img) => img.stage === "before_repair"), "修补前分组中所有影像阶段正确");
  assert(grouped.during_repair.every((img) => img.stage === "during_repair"), "修补中分组中所有影像阶段正确");
  assert(grouped.after_repair.every((img) => img.stage === "after_repair"), "修补后分组中所有影像阶段正确");

  await stopServer();

  console.log("\n【场景4】影像阶段校验——无效阶段");
  seedDb();
  await startServer();

  const invalidStageRes = await httpRequest("POST", "/damages/d1/images", {
    stage: "invalid_stage",
    url: "https://example.local/x.jpg",
    capturedAt: "2026-06-10T09:00:00.000Z",
    description: "测试",
    collector: "张师傅"
  });
  assertEqual(invalidStageRes.status, 400, "无效阶段返回 400");
  assert(invalidStageRes.body.error.includes("阶段无效"), "错误信息包含阶段无效提示");

  await stopServer();

  console.log("\n【场景5】影像URL校验——空URL");
  seedDb();
  await startServer();

  const emptyUrlRes = await httpRequest("POST", "/damages/d1/images", {
    stage: "before_repair",
    url: "",
    description: "测试"
  });
  assertEqual(emptyUrlRes.status, 400, "空URL返回 400");
  assert(emptyUrlRes.body.error.includes("URL不能为空"), "错误信息包含URL不能为空提示");

  await stopServer();

  console.log("\n【场景6】影像URL校验——非法URL格式");
  seedDb();
  await startServer();

  const invalidUrlRes = await httpRequest("POST", "/damages/d1/images", {
    stage: "before_repair",
    url: "not-a-url",
    description: "测试"
  });
  assertEqual(invalidUrlRes.status, 400, "非法URL返回 400");
  assert(invalidUrlRes.body.error.includes("URL格式无效"), "错误信息包含URL格式无效提示");

  await stopServer();

  console.log("\n【场景7】缺损归属校验——不存在的缺损项");
  seedDb();
  await startServer();

  const notExistRes = await httpRequest("POST", "/damages/nonexistent/images", {
    stage: "before_repair",
    url: "https://example.local/x.jpg"
  });
  assertEqual(notExistRes.status, 404, "不存在的缺损项返回 404");

  const getNotExistRes = await httpRequest("GET", "/damages/nonexistent/images");
  assertEqual(getNotExistRes.status, 404, "查询不存在的缺损项影像返回 404");

  await stopServer();

  console.log("\n【场景8】完成批次时批量写入归档影像");
  seedDb();
  await startServer();

  const completeRes = await httpRequest("POST", "/batches/b1/complete", {
    note: "批次完成",
    results: [
      { damageId: "d1", afterPhotoUrl: "https://example.local/after-d1.jpg", repairNote: "修补完成" },
      { damageId: "d2", afterPhotoUrl: "https://example.local/after-d2.jpg", repairNote: "修补完成" }
    ],
    archiveImages: [
      { damageId: "d1", stage: "before_repair", url: "https://example.local/batch-before-d1.jpg", capturedAt: "2026-06-10T09:00:00.000Z", description: "批次归档-修补前", collector: "张师傅" },
      { damageId: "d1", stage: "during_repair", url: "https://example.local/batch-during-d1.jpg", capturedAt: "2026-06-11T14:00:00.000Z", description: "批次归档-修补中", collector: "李师傅" },
      { damageId: "d1", stage: "after_repair", url: "https://example.local/batch-after-d1.jpg", capturedAt: "2026-06-12T16:00:00.000Z", description: "批次归档-修补后", collector: "李师傅" },
      { damageId: "d2", stage: "before_repair", url: "https://example.local/batch-before-d2.jpg", capturedAt: "2026-06-10T10:00:00.000Z", description: "批次归档-修补前d2", collector: "张师傅" },
      { damageId: "d2", stage: "after_repair", url: "https://example.local/batch-after-d2.jpg", capturedAt: "2026-06-13T10:00:00.000Z", description: "批次归档-修补后d2", collector: "李师傅" }
    ]
  });
  assertEqual(completeRes.status, 200, "完成批次返回 200");

  const d1ImagesRes = await httpRequest("GET", "/damages/d1/images");
  const d1Grouped = d1ImagesRes.body.data;
  assertEqual(d1Grouped.before_repair.length, 1, "d1 修补前影像 1 张");
  assertEqual(d1Grouped.during_repair.length, 1, "d1 修补中影像 1 张");
  assertEqual(d1Grouped.after_repair.length, 1, "d1 修补后影像 1 张");

  const d2ImagesRes = await httpRequest("GET", "/damages/d2/images");
  const d2Grouped = d2ImagesRes.body.data;
  assertEqual(d2Grouped.before_repair.length, 1, "d2 修补前影像 1 张");
  assertEqual(d2Grouped.after_repair.length, 1, "d2 修补后影像 1 张");
  assertEqual(d2Grouped.during_repair.length, 0, "d2 修补中影像 0 张");

  await stopServer();

  console.log("\n【场景9】完成批次时归属校验——影像归属不属于当前批次的缺损项");
  seedDb();
  writeDb({
    rubbings: [
      { id: "r1", code: "TP-清-014", source: "地方碑刻残页", paperSize: "42x68cm", note: "", createdAt: "2026-01-01T00:00:00.000Z" }
    ],
    damages: [
      { id: "d1", rubbingId: "r1", position: "左上角", type: "虫蛀孔", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "in_repair", repairNote: "", batchId: "b1", createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null, reviewStatus: "approved", rejectReason: "" },
      { id: "d2", rubbingId: "r1", position: "下边缘", type: "撕裂", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null, reviewStatus: "approved", rejectReason: "" }
    ],
    batches: [
      { id: "b1", name: "六月修补批次", status: "open", damageIds: ["d1"], note: "", createdAt: "2026-06-01T00:00:00.000Z", completedAt: null, plannedStartAt: null, plannedEndAt: null, responsible: null }
    ],
    repairImages: []
  });
  await startServer();

  const ownershipRes = await httpRequest("POST", "/batches/b1/complete", {
    archiveImages: [
      { damageId: "d1", stage: "after_repair", url: "https://example.local/after-d1.jpg", description: "属于批次" },
      { damageId: "d2", stage: "after_repair", url: "https://example.local/after-d2.jpg", description: "不属于批次" }
    ]
  });
  assertEqual(ownershipRes.status, 400, "归属校验失败返回 400");
  assert(ownershipRes.body.error.includes("归属校验失败"), "错误信息包含归属校验失败");
  assert(ownershipRes.body.error.includes("d2"), "错误信息指出不属于批次的缺损项 d2");

  await stopServer();

  console.log("\n【场景10】完成批次时影像阶段和URL校验");
  seedDb();
  await startServer();

  const stageUrlRes = await httpRequest("POST", "/batches/b1/complete", {
    archiveImages: [
      { damageId: "d1", stage: "bad_stage", url: "https://example.local/x.jpg" },
      { damageId: "d2", stage: "after_repair", url: "" },
      { damageId: "d2", stage: "before_repair", url: "not-a-url" }
    ]
  });
  assertEqual(stageUrlRes.status, 400, "批次完成时影像校验失败返回 400");
  assert(stageUrlRes.body.error.includes("阶段无效"), "错误信息包含阶段无效");
  assert(stageUrlRes.body.error.includes("URL不能为空"), "错误信息包含URL不能为空");
  assert(stageUrlRes.body.error.includes("URL格式无效"), "错误信息包含URL格式无效");

  await stopServer();

  console.log("\n【场景11】PATCH缺损项详情返回按阶段分组的影像");
  seedDb();
  writeDb({
    rubbings: [
      { id: "r1", code: "TP-清-014", source: "地方碑刻残页", paperSize: "42x68cm", note: "", createdAt: "2026-01-01T00:00:00.000Z" }
    ],
    damages: [
      { id: "d1", rubbingId: "r1", position: "左上角", type: "虫蛀孔", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: "2026-01-01T00:00:00.000Z", repairedAt: null, reviewStatus: "approved", rejectReason: "" }
    ],
    batches: [],
    repairImages: [
      { id: "img_1", damageId: "d1", stage: "before_repair", url: "https://example.local/b1.jpg", capturedAt: "2026-06-10T09:00:00.000Z", description: "修补前", collector: "张师傅", createdAt: "2026-06-10T09:00:00.000Z" },
      { id: "img_2", damageId: "d1", stage: "after_repair", url: "https://example.local/a1.jpg", capturedAt: "2026-06-12T16:00:00.000Z", description: "修补后", collector: "李师傅", createdAt: "2026-06-12T16:00:00.000Z" }
    ]
  });
  await startServer();

  const patchRes = await httpRequest("PATCH", "/damages/d1", { repairNote: "已修补完成" });
  assertEqual(patchRes.status, 200, "PATCH 缺损项返回 200");
  const patchData = patchRes.body.data;
  assert(patchData.images !== undefined, "PATCH 返回包含 images 字段");
  assertEqual(patchData.images.before_repair.length, 1, "PATCH 返回修补前影像 1 张");
  assertEqual(patchData.images.after_repair.length, 1, "PATCH 返回修补后影像 1 张");
  assertEqual(patchData.images.during_repair.length, 0, "PATCH 返回修补中影像 0 张");

  await stopServer();

  console.log("\n【场景12】空影像列表查询");
  seedDb();
  await startServer();

  const emptyImagesRes = await httpRequest("GET", "/damages/d1/images");
  assertEqual(emptyImagesRes.status, 200, "空影像查询返回 200");
  const emptyGrouped = emptyImagesRes.body.data;
  assertEqual(emptyGrouped.before_repair.length, 0, "修补前影像为 0");
  assertEqual(emptyGrouped.during_repair.length, 0, "修补中影像为 0");
  assertEqual(emptyGrouped.after_repair.length, 0, "修补后影像为 0");

  await stopServer();

  console.log("\n【场景13】完成批次时不传 archiveImages 仍然正常");
  seedDb();
  await startServer();

  const noArchiveRes = await httpRequest("POST", "/batches/b1/complete", {
    note: "完成",
    results: [
      { damageId: "d1", afterPhotoUrl: "https://example.local/after-d1.jpg" },
      { damageId: "d2", afterPhotoUrl: "https://example.local/after-d2.jpg" }
    ]
  });
  assertEqual(noArchiveRes.status, 200, "不传 archiveImages 完成批次返回 200");
  assertEqual(noArchiveRes.body.data.status, "completed", "批次状态为 completed");

  await stopServer();

  console.log("\n【场景14】health 接口包含新路由");
  seedDb();
  await startServer();

  const healthRes = await httpRequest("GET", "/health");
  assert(healthRes.body.routes.includes("GET /damages/:id/images"), "health 路由列表包含 GET /damages/:id/images");
  assert(healthRes.body.routes.includes("POST /damages/:id/images"), "health 路由列表包含 POST /damages/:id/images");

  await stopServer();

  console.log("\n【场景15】批量登记时空数组校验");
  seedDb();
  await startServer();

  const emptyArrRes = await httpRequest("POST", "/damages/d1/images", { images: [] });
  assertEqual(emptyArrRes.status, 400, "空数组返回 400");
  assert(emptyArrRes.body.error.includes("不能为空数组"), "错误信息提示不能为空数组");

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
