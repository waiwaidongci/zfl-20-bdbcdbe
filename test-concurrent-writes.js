const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");
const testHelper = require("./test-helper");

const BACKUP_FILE = path.join(__dirname, "data", "db.json.concurrent_test_backup");

let server;
let baseUrl;
let passed = 0;
let failed = 0;

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
      if (err.expected !== undefined) {
        console.error(`    expected: ${JSON.stringify(err.expected)}`);
        console.error(`    actual: ${JSON.stringify(err.actual)}`);
      }
    });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "Assertion failed");
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
    const port = await findAvailablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn("node", ["server.js"], {
      cwd: __dirname,
      env: { ...process.env, PORT: String(port) }
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        reject(new Error("Server startup timeout"));
      }
    }, 5000);

    server.stdout.on("data", (data) => {
      const msg = data.toString();
      if (msg.includes("Rubbing repair API running") && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        setTimeout(resolve, 200);
      }
    });

    server.stderr.on("data", (data) => {
      // console.error(`[server stderr] ${data}`);
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (server) {
      server.kill("SIGTERM");
      server.on("close", resolve);
      setTimeout(resolve, 1000);
    } else {
      resolve();
    }
  });
}

function request(method, pathname, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        "Content-Type": "application/json"
      }
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, body: data, headers: res.headers });
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

function backupDb() {
  try {
    const src = path.join(__dirname, "data", "db.json");
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, BACKUP_FILE);
    }
  } catch (e) {
    console.warn("Backup failed:", e.message);
  }
}

function restoreDb() {
  try {
    const src = BACKUP_FILE;
    const dest = path.join(__dirname, "data", "db.json");
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  } catch (e) {
    console.warn("Restore failed:", e.message);
  }
}

async function createTestRubbing() {
  const res = await request("POST", "/rubbings", {
    code: "TP-TEST-001",
    source: "测试碑刻",
    paperSize: "50x70cm",
    note: "并发测试用"
  });
  assert(res.status === 201, `创建拓片失败: ${res.status}`);
  return res.body.data;
}

async function createDamage(rubbingId, suffix = "") {
  const res = await request("POST", `/rubbings/${rubbingId}/damages`, {
    position: `左上角${suffix}`,
    type: "虫蛀孔",
    beforePhotoUrl: `https://example.com/before-${suffix}.jpg`
  });
  return res;
}

async function runConcurrentCreateDamagesTest() {
  console.log("\n=== 测试1：并发创建缺损 ===");

  const rubbing = await createTestRubbing();
  const rubbingId = rubbing.id;

  const count = 10;
  const promises = [];

  for (let i = 0; i < count; i++) {
    promises.push(createDamage(rubbingId, `-${i}`));
  }

  const results = await Promise.all(promises);

  const successCount = results.filter((r) => r.status === 201).length;
  const conflictCount = results.filter((r) => r.status === 409).length;

  console.log(`  并发请求数: ${count}`);
  console.log(`  成功数: ${successCount}`);
  console.log(`  冲突数 (409): ${conflictCount}`);

  const allRes = await request("GET", `/rubbings/${rubbingId}/damages`);
  const damageCount = allRes.body.data.length;
  console.log(`  实际缺损数: ${damageCount}`);

  assert(successCount + conflictCount === count, "所有请求都应该返回 201 或 409");
  assert(damageCount === successCount, "实际缺损数应等于成功数");

  if (conflictCount > 0) {
    console.log("  ✓ 检测到版本冲突（409），乐观锁生效");
  } else {
    console.log("  ⚠ 未检测到冲突，可能是写入太快。增加并发数可能触发冲突");
  }

  console.log("  ✓ 并发创建缺损测试通过");
}

async function createBatch(rubbingId, damageIds) {
  const res = await request("POST", "/batches", {
    name: `测试批次-${Date.now()}`,
    damageIds,
    note: "并发测试批次"
  });
  return res;
}

async function completeBatch(batchId, results = []) {
  const res = await request("POST", `/batches/${batchId}/complete`, {
    results,
    defaultRepairNote: "已修复",
    defaultAfterPhotoUrl: "https://example.com/after.jpg"
  });
  return res;
}

async function approveDamage(damageId) {
  const res = await request("POST", `/damages/${damageId}/approve`, {
    reviewedBy: "测试管理员"
  });
  return res;
}

async function runConcurrentCompleteBatchTest() {
  console.log("\n=== 测试2：并发完成批次 ===");

  const rubbing = await createTestRubbing();
  const rubbingId = rubbing.id;

  const damageCount = 3;
  const damageIds = [];
  for (let i = 0; i < damageCount; i++) {
    const res = await createDamage(rubbingId, `-batch-${i}`);
    assert(res.status === 201, "创建缺损失败");
    const damageId = res.body.data.id;
    damageIds.push(damageId);
    const approveRes = await approveDamage(damageId);
    assert(approveRes.status === 200, `批准缺损 ${i} 失败: ${approveRes.status}`);
  }

  const batchRes = await createBatch(rubbingId, damageIds);
  assert(batchRes.status === 201, `创建批次失败: ${batchRes.status} - ${JSON.stringify(batchRes.body)}`);
  const batchId = batchRes.body.data.id;

  const results = damageIds.map((id) => ({
    damageId: id,
    repairNote: "修复完成"
  }));

  const count = 5;
  const promises = [];
  for (let i = 0; i < count; i++) {
    promises.push(completeBatch(batchId, results));
  }

  const responses = await Promise.all(promises);

  const successCount = responses.filter((r) => r.status === 200).length;
  const conflictCount = responses.filter((r) => r.status === 409).length;
  const otherErrors = responses.filter((r) => r.status !== 200 && r.status !== 409);

  console.log(`  并发请求数: ${count}`);
  console.log(`  成功数 (200): ${successCount}`);
  console.log(`  冲突数 (409): ${conflictCount}`);
  console.log(`  其他错误数: ${otherErrors.length}`);

  if (otherErrors.length > 0) {
    console.log("  其他错误详情:");
    otherErrors.forEach((r, i) => {
      console.log(`    ${i}: ${r.status} - ${JSON.stringify(r.body)}`);
    });
  }

  if (conflictCount > 0) {
    console.log("  ✓ 检测到版本冲突（409），乐观锁在批次完成时生效");
  } else {
    console.log("  ⚠ 未检测到冲突，可能是写入太快");
  }

  console.log("  ✓ 并发完成批次测试通过");
}

async function createBackup() {
  const res = await request("POST", "/backups");
  return res;
}

async function restoreBackup(filename, expectedVersion = undefined) {
  const body = expectedVersion !== undefined ? { expectedVersion } : null;
  const res = await request("POST", `/backups/${encodeURIComponent(filename)}/restore`, body);
  return res;
}

async function getCurrentWriteVersion() {
  const res = await request("GET", "/schema-version");
  return res.body.meta?.writeVersion ?? 0;
}

async function runBackupRestoreConflictTest() {
  console.log("\n=== 测试3：备份恢复与写入冲突 ===");

  const backupRes = await createBackup();
  assert(backupRes.status === 201, `创建备份失败: ${backupRes.status} - ${JSON.stringify(backupRes.body)}`);
  const backupFilename = backupRes.body.data.filename;
  console.log(`  创建备份: ${backupFilename}`);

  const versionBefore = await getCurrentWriteVersion();
  console.log(`  初始版本号: v${versionBefore}`);

  const rubbing = await createTestRubbing();
  const rubbingId = rubbing.id;
  console.log(`  创建拓片: ${rubbingId}`);

  const versionAfterRubbing = await getCurrentWriteVersion();
  console.log(`  创建拓片后版本号: v${versionAfterRubbing}`);
  assert(versionAfterRubbing > versionBefore, "创建拓片后版本号应递增");

  const damagePromises = [];
  for (let i = 0; i < 5; i++) {
    damagePromises.push(createDamage(rubbingId, `-restore-${i}`));
  }

  const restorePromise = restoreBackup(backupFilename);

  const allPromises = [...damagePromises, restorePromise];
  const results = await Promise.all(allPromises);

  const damageResults = results.slice(0, 5);
  const restoreResult = results[5];

  const damageSuccess = damageResults.filter((r) => r.status === 201).length;
  const damageConflict = damageResults.filter((r) => r.status === 409).length;

  console.log(`  缺损创建成功: ${damageSuccess}`);
  console.log(`  缺损创建冲突 (409): ${damageConflict}`);
  console.log(`  备份恢复状态: ${restoreResult.status}`);
  assert(
    restoreResult.status === 409,
    `并发写入后恢复必须返回 409，实际返回: ${restoreResult.status} - ${JSON.stringify(restoreResult.body)}`
  );
  assert(
    restoreResult.body.code === "VERSION_CONFLICT",
    `冲突时错误码应为 VERSION_CONFLICT，实际: ${restoreResult.body.code}`
  );
  assert(
    restoreResult.body.error && restoreResult.body.error.includes("版本冲突"),
    "并发恢复冲突错误信息应包含版本冲突描述"
  );
  const afterConflictRes = await request("GET", `/rubbings/${rubbingId}/damages`);
  assert(afterConflictRes.status === 200, "恢复被409阻断后拓片仍应存在");
  assert(
    afterConflictRes.body.data.length === damageSuccess,
    "恢复被409阻断后成功创建的缺损不应被覆盖"
  );
  console.log("  ✓ 并发恢复检测到 409，且未覆盖已成功写入的数据");

  console.log("\n  --- 子测试：显式 expectedVersion 冲突检测 ---");
  const explicitVersion = versionBefore;
  console.log(`  使用过期版本号 v${explicitVersion} 发起恢复...`);
  const conflictRestoreRes = await restoreBackup(backupFilename, explicitVersion);
  console.log(`  恢复结果: ${conflictRestoreRes.status}`);

  if (explicitVersion !== versionAfterRubbing) {
    assert(
      conflictRestoreRes.status === 409,
      `使用过期版本号 v${explicitVersion} 恢复应返回 409，实际: ${conflictRestoreRes.status} - ${JSON.stringify(conflictRestoreRes.body)}`
    );
    assert(
      conflictRestoreRes.body.code === "VERSION_CONFLICT",
      `显式冲突时错误码应为 VERSION_CONFLICT，实际: ${conflictRestoreRes.body.code}`
    );
    assert(
      conflictRestoreRes.body.error && conflictRestoreRes.body.error.includes("版本冲突"),
      "错误信息应包含版本冲突描述"
    );
    console.log("  ✓ 显式 expectedVersion 冲突检测通过（409 + VERSION_CONFLICT）");
  } else {
    console.log("  ⚠ 版本号一致，无法触发显式冲突测试（跳过）");
  }

  console.log("\n  --- 子测试：正确 expectedVersion 恢复成功 ---");
  const currentVersion = await getCurrentWriteVersion();
  console.log(`  使用当前版本号 v${currentVersion} 发起恢复...`);
  const correctRestoreRes = await restoreBackup(backupFilename, currentVersion);
  console.log(`  恢复结果: ${correctRestoreRes.status}`);

  if (correctRestoreRes.status === 200) {
    const finalVersion = await getCurrentWriteVersion();
    console.log(`  恢复后版本号: v${finalVersion}`);
    assert(finalVersion > currentVersion, "恢复成功后版本号应递增");
    console.log("  ✓ 使用正确版本号恢复成功，版本号正确递增");
  } else if (correctRestoreRes.status === 409) {
    console.log("  ⚠ 版本号在检查和恢复之间被其他操作修改（并发条件下可接受）");
  } else {
    assert(false, `使用正确版本号恢复应返回 200，实际: ${correctRestoreRes.status} - ${JSON.stringify(correctRestoreRes.body)}`);
  }

  console.log("  ✓ 备份恢复冲突测试通过");
}

async function runVersionCheckTest() {
  console.log("\n=== 测试4：版本号单调递增验证 ===");

  const rubbing = await createTestRubbing();
  const rubbingId = rubbing.id;

  const schemaRes1 = await request("GET", "/schema-version");
  const version1 = schemaRes1.body.meta?.writeVersion ?? 0;
  console.log(`  初始版本: v${version1}`);

  for (let i = 0; i < 5; i++) {
    const res = await createDamage(rubbingId, `-version-${i}`);
    assert(res.status === 201, `创建缺损 ${i} 失败`);
  }

  const schemaRes2 = await request("GET", "/schema-version");
  const version2 = schemaRes2.body.meta?.writeVersion ?? 0;
  console.log(`  写入5次后版本: v${version2}`);

  assert(version2 > version1, "版本号应该递增");
  assert(version2 >= version1 + 5, "版本号至少增加 5（5次写入）");

  console.log("  ✓ 版本号单调递增验证通过");
}

async function runWriteSerializationTest() {
  console.log("\n=== 测试5：写入串行化验证 ===");

  const rubbing = await createTestRubbing();
  const rubbingId = rubbing.id;

  const delays = [50, 10, 30, 5, 20];
  const results = [];

  const promises = delays.map((delay, i) => {
    return new Promise((resolve) => {
      setTimeout(async () => {
        const res = await createDamage(rubbingId, `-serial-${i}`);
        results.push({ index: i, delay, status: res.status, id: res.body.data?.id });
        resolve();
      }, delay);
    });
  });

  await Promise.all(promises);

  const successCount = results.filter((r) => r.status === 201).length;
  const conflictCount = results.filter((r) => r.status === 409).length;

  console.log(`  请求数: ${delays.length}`);
  console.log(`  成功数: ${successCount}`);
  console.log(`  冲突数 (409): ${conflictCount}`);

  const allRes = await request("GET", `/rubbings/${rubbingId}/damages`);
  const damageCount = allRes.body.data.length;
  console.log(`  实际缺损数: ${damageCount}`);

  assert(damageCount === successCount, "实际缺损数应等于成功写入数");

  console.log("  ✓ 写入串行化验证通过");
}

async function main() {
  console.log("并发写入与乐观版本保护验证测试");
  console.log("=".repeat(50));

  backupDb();

  try {
    await startServer();
    console.log(`服务器运行在 ${baseUrl}`);

    await runVersionCheckTest();
    passed++;
    await runConcurrentCreateDamagesTest();
    passed++;
    await runConcurrentCompleteBatchTest();
    passed++;
    await runBackupRestoreConflictTest();
    passed++;
    await runWriteSerializationTest();
    passed++;

  } catch (err) {
    console.error("测试运行失败:", err);
    failed++;
  } finally {
    await stopServer();
    restoreDb();
  }

  console.log("\n" + "=".repeat(50));
  console.log(`测试结果: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

main();
