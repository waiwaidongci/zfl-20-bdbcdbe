const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const testHelper = require("./test-helper");

const BACKUP_FILE = path.join(__dirname, "data", "db.json.importtest");
const AUDIT_LOG_FILE = path.join(__dirname, "data", "audit-logs.json");
const AUDIT_LOG_BACKUP_FILE = path.join(__dirname, "data", "audit-logs.json.importtest");
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

function getRubbingCount() {
  const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  const rubbings = raw.entities ? raw.entities.rubbings : raw.rubbings;
  return rubbings.length;
}

function getDamageCount() {
  const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  const damages = raw.entities ? raw.entities.damages : raw.damages;
  return damages.length;
}

async function prepareTestData() {
  const testData = {
    rubbings: [
      { id: "r_exist1", code: "TP-已存在-001", source: "已有来源", paperSize: "30x40cm", note: "已有拓片1", createdAt: new Date().toISOString() }
    ],
    damages: [],
    batches: [],
    repairImages: [],
    batchSnapshots: [],
    auditTrail: []
  };
  writeDb(testData);
}

async function testScenario1_PrecheckNoDbWrite() {
  console.log("\n=== 场景1：precheck 只生成预检结果不落库 ===");

  const rubbingsBefore = getRubbingCount();
  const damagesBefore = getDamageCount();

  const importData = {
    rubbings: [
      { code: "TP-预检-001", source: "预检来源1", paperSize: "50x70cm", note: "预检测试拓片1" },
      { code: "TP-预检-002", source: "预检来源2", paperSize: "60x90cm", note: "预检测试拓片2" }
    ],
    damages: [
      { rubbingId: "TP-预检-001", position: "左上角", type: "虫蛀孔", beforePhotoUrl: "https://example.com/pre1.jpg" }
    ]
  };

  const precheckRes = await httpRequest("POST", "/import/precheck", importData);
  assertEqual(precheckRes.status, 200, "precheck 返回 200");
  assertTrue(!!precheckRes.body.precheckToken, "precheck 返回 precheckToken");
  assertTrue(!!precheckRes.body.precheckTokenExpiresAt, "precheck 返回过期时间");
  assertEqual(precheckRes.body.total.rubbings, 2, "precheck total.rubbings 为 2");
  assertEqual(precheckRes.body.total.damages, 1, "precheck total.damages 为 1");
  assertEqual(precheckRes.body.importable.rubbings, 2, "precheck importable.rubbings 为 2");
  assertEqual(precheckRes.body.importable.damages, 1, "precheck importable.damages 为 1");
  assertEqual(precheckRes.body.rubbings.length, 2, "precheck 返回 2 条拓片预检结果");
  assertEqual(precheckRes.body.rubbings[0].status, "valid", "第一条拓片预检状态为 valid");
  assertEqual(precheckRes.body.damages[0].status, "valid", "第一条缺损项预检状态为 valid");

  const rubbingsAfter = getRubbingCount();
  const damagesAfter = getDamageCount();
  assertEqual(rubbingsAfter, rubbingsBefore, "precheck 后拓片数量不变（未落库）");
  assertEqual(damagesAfter, damagesBefore, "precheck 后缺损项数量不变（未落库）");
}

async function testScenario2_ConfirmWritesToDb() {
  console.log("\n=== 场景2：confirm 成功写入拓片和缺损项 ===");

  const rubbingsBefore = getRubbingCount();
  const damagesBefore = getDamageCount();

  const importData = {
    rubbings: [
      { code: "TP-确认-001", source: "确认来源1", paperSize: "50x70cm", note: "确认测试拓片1" },
      { code: "TP-确认-002", source: "确认来源2", paperSize: "60x90cm", note: "确认测试拓片2" }
    ],
    damages: [
      { rubbingId: "TP-确认-001", position: "左上角", type: "虫蛀孔", beforePhotoUrl: "https://example.com/c1.jpg", status: "pending", reviewStatus: "approved" },
      { rubbingId: "TP-确认-002", position: "右上角", type: "撕裂", beforePhotoUrl: "https://example.com/c2.jpg", status: "in_repair", reviewStatus: "review_pending" }
    ]
  };

  const precheckRes = await httpRequest("POST", "/import/precheck", importData);
  assertEqual(precheckRes.status, 200, "precheck 成功");
  const precheckToken = precheckRes.body.precheckToken;

  const confirmData = { ...importData, precheckToken };
  const confirmRes = await httpRequest("POST", "/import/confirm", confirmData);
  assertEqual(confirmRes.status, 201, "confirm 返回 201");
  assertEqual(confirmRes.body.imported.rubbings, 2, "confirm 报告导入 2 条拓片");
  assertEqual(confirmRes.body.imported.damages, 2, "confirm 报告导入 2 条缺损项");
  assertEqual(confirmRes.body.skipped.rubbings, 0, "confirm 报告跳过 0 条拓片");
  assertEqual(confirmRes.body.skipped.damages, 0, "confirm 报告跳过 0 条缺损项");
  assertTrue(!!confirmRes.body.rowMapping, "confirm 返回 rowMapping");
  assertTrue(!!confirmRes.body.rowMapping.rubbings, "confirm 返回 rubbings rowMapping");
  assertTrue(!!confirmRes.body.rowMapping.damages, "confirm 返回 damages rowMapping");
  assertEqual(Object.keys(confirmRes.body.rowMapping.rubbings).length, 2, "rowMapping.rubbings 有 2 条映射");
  assertEqual(Object.keys(confirmRes.body.rowMapping.damages).length, 2, "rowMapping.damages 有 2 条映射");

  const rubbingsAfter = getRubbingCount();
  const damagesAfter = getDamageCount();
  assertEqual(rubbingsAfter, rubbingsBefore + 2, "confirm 后拓片数量增加 2");
  assertEqual(damagesAfter, damagesBefore + 2, "confirm 后缺损项数量增加 2");

  const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  const rubbings = raw.entities ? raw.entities.rubbings : raw.rubbings;
  const damages = raw.entities ? raw.entities.damages : raw.damages;

  const rubbing1 = rubbings.find((r) => r.code === "TP-确认-001");
  assertTrue(!!rubbing1, "数据库中存在 TP-确认-001 拓片");
  assertEqual(rubbing1.source, "确认来源1", "拓片 source 正确");
  assertEqual(rubbing1.paperSize, "50x70cm", "拓片 paperSize 正确");

  const rubbing2 = rubbings.find((r) => r.code === "TP-确认-002");
  assertTrue(!!rubbing2, "数据库中存在 TP-确认-002 拓片");

  const damage1 = damages.find((d) => d.position === "左上角" && d.type === "虫蛀孔");
  assertTrue(!!damage1, "数据库中存在 左上角虫蛀孔 缺损项");
  assertEqual(damage1.status, "pending", "缺损项 status 正确");
  assertEqual(damage1.reviewStatus, "approved", "缺损项 reviewStatus 正确");
  assertEqual(damage1.rubbingId, rubbing1.id, "缺损项 rubbingId 指向正确的拓片");

  const damage2 = damages.find((d) => d.position === "右上角" && d.type === "撕裂");
  assertTrue(!!damage2, "数据库中存在 右上角撕裂 缺损项");
  assertEqual(damage2.rubbingId, rubbing2.id, "缺损项 rubbingId 指向正确的拓片");
}

async function testScenario3_DuplicateRubbingCodeSkipped() {
  console.log("\n=== 场景3：重复拓片编号被跳过 ===");

  const rubbingsBefore = getRubbingCount();
  const damagesBefore = getDamageCount();

  const importData = {
    rubbings: [
      { code: "TP-已存在-001", source: "重复来源", paperSize: "40x50cm", note: "重复编号测试" },
      { code: "TP-新编号-001", source: "新来源", paperSize: "60x80cm", note: "新编号测试" }
    ],
    damages: [
      { rubbingId: "TP-已存在-001", position: "左下角", type: "霉斑", beforePhotoUrl: "https://example.com/dup1.jpg" },
      { rubbingId: "TP-新编号-001", position: "右下角", type: "折痕", beforePhotoUrl: "https://example.com/dup2.jpg" }
    ]
  };

  const precheckRes = await httpRequest("POST", "/import/precheck", importData);
  assertEqual(precheckRes.status, 200, "precheck 成功");
  assertEqual(precheckRes.body.total.rubbings, 2, "precheck total.rubbings 为 2");
  assertEqual(precheckRes.body.importable.rubbings, 1, "precheck importable.rubbings 为 1（跳过重复）");
  assertEqual(precheckRes.body.rubbings[0].status, "invalid", "重复拓片预检状态为 invalid");
  assertContains(precheckRes.body.rubbings[0].errors[0], "已存在于数据库中", "重复拓片错误信息包含已存在提示");
  assertEqual(precheckRes.body.rubbings[1].status, "valid", "新拓片预检状态为 valid");

  const precheckToken = precheckRes.body.precheckToken;
  const confirmData = { ...importData, precheckToken };
  const confirmRes = await httpRequest("POST", "/import/confirm", confirmData);
  assertEqual(confirmRes.status, 201, "confirm 返回 201");
  assertEqual(confirmRes.body.imported.rubbings, 1, "confirm 报告导入 1 条拓片");
  assertEqual(confirmRes.body.skipped.rubbings, 1, "confirm 报告跳过 1 条拓片");

  const rubbingsAfter = getRubbingCount();
  assertEqual(rubbingsAfter, rubbingsBefore + 1, "confirm 后拓片数量只增加 1（重复编号未写入）");

  const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  const rubbings = raw.entities ? raw.entities.rubbings : raw.rubbings;
  const existingRubbings = rubbings.filter((r) => r.code === "TP-已存在-001");
  assertEqual(existingRubbings.length, 1, "重复编号拓片仍然只有 1 条（未新增）");
  const newRubbing = rubbings.find((r) => r.code === "TP-新编号-001");
  assertTrue(!!newRubbing, "新编号拓片成功写入");
}

async function testScenario4_DamageReferencingNonExistentRubbing() {
  console.log("\n=== 场景4：缺损项引用不存在拓片时返回可读错误 ===");

  const rubbingsBefore = getRubbingCount();

  const importData = {
    rubbings: [
      { code: "TP-引用测试-001", source: "引用测试来源", paperSize: "50x70cm", note: "引用测试拓片" }
    ],
    damages: [
      { rubbingId: "TP-不存在的拓片", position: "顶部", type: "缺失", beforePhotoUrl: "https://example.com/ref1.jpg" },
      { rubbingId: "TP-引用测试-001", position: "底部", type: "磨损", beforePhotoUrl: "https://example.com/ref2.jpg" }
    ]
  };

  const precheckRes = await httpRequest("POST", "/import/precheck", importData);
  assertEqual(precheckRes.status, 200, "precheck 返回 200");
  assertEqual(precheckRes.body.total.damages, 2, "precheck total.damages 为 2");
  assertEqual(precheckRes.body.importable.damages, 1, "precheck importable.damages 为 1（跳过无效引用）");

  const invalidDamage = precheckRes.body.damages.find((d) => d.data.rubbingId === "TP-不存在的拓片");
  assertTrue(!!invalidDamage, "precheck 返回引用不存在拓片的缺损项结果");
  assertEqual(invalidDamage.status, "invalid", "引用不存在拓片的缺损项状态为 invalid");
  assertTrue(invalidDamage.errors.length > 0, "引用不存在拓片的缺损项有错误信息");
  assertContains(invalidDamage.errors[0], "不存在", "错误信息包含'不存在'提示");
  assertContains(invalidDamage.errors[0], "拓片", "错误信息提到拓片");
  assertContains(invalidDamage.errors[0], "数据库", "错误信息提到数据库");

  const validDamage = precheckRes.body.damages.find((d) => d.data.rubbingId === "TP-引用测试-001");
  assertTrue(!!validDamage, "precheck 返回引用有效拓片的缺损项结果");
  assertEqual(validDamage.status, "valid", "引用有效拓片的缺损项状态为 valid");
  assertTrue(!!validDamage.resolvedRubbing, "valid 缺损项有 resolvedRubbing 信息");
  assertEqual(validDamage.resolvedRubbing.source, "import", "resolvedRubbing.source 为 import");

  const precheckToken = precheckRes.body.precheckToken;
  const confirmData = { ...importData, precheckToken };
  const confirmRes = await httpRequest("POST", "/import/confirm", confirmData);
  assertEqual(confirmRes.status, 201, "confirm 返回 201");
  assertEqual(confirmRes.body.imported.damages, 1, "confirm 只导入 1 条缺损项（跳过无效引用）");
  assertEqual(confirmRes.body.skipped.damages, 1, "confirm 报告跳过 1 条缺损项");

  const rubbingsAfter = getRubbingCount();
  assertEqual(rubbingsAfter, rubbingsBefore + 1, "confirm 后拓片数量增加 1");
}

async function main() {
  try {
    console.log("批量导入流程回归测试");
    console.log("=".repeat(50));

    backupDb();
    prepareTestData();
    await startServer();

    await testScenario1_PrecheckNoDbWrite();
    await testScenario2_ConfirmWritesToDb();
    await testScenario3_DuplicateRubbingCodeSkipped();
    await testScenario4_DamageReferencingNonExistentRubbing();

    console.log("\n" + "=".repeat(50));
    console.log(`测试结果: 通过 ${passed} / ${passed + failed}`);
    if (failed > 0) {
      console.log(`失败 ${failed} 个用例`);
      process.exitCode = 1;
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
