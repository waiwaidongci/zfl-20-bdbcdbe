const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const testHelper = require("./test-helper");

const BACKUP_FILE = path.join(__dirname, "data", "db.json.reviewbackup");
const CONFIGURED_PORT = process.env.TEST_REVIEW_PORT ? Number(process.env.TEST_REVIEW_PORT) : null;

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

function writeDb(data, options = {}) {
  testHelper.writeDb(data, options);
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

function seedReviewTestDb() {
  writeDb({
    rubbings: [
      { id: "r1", code: "TP-清-014", source: "地方碑刻残页", paperSize: "42x68cm", note: "边缘有旧折痕", createdAt: "2026-01-15T00:00:00.000Z" }
    ],
    damages: [
      { id: "d1", rubbingId: "r1", position: "左上角", type: "虫蛀孔", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, reviewStatus: "review_pending", rejectReason: "", createdAt: "2026-01-16T00:00:00.000Z", repairedAt: null },
      { id: "d2", rubbingId: "r1", position: "下边缘", type: "撕裂", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, reviewStatus: "review_pending", rejectReason: "", createdAt: "2026-01-16T00:00:00.000Z", repairedAt: null },
      { id: "d3", rubbingId: "r1", position: "中央", type: "霉斑", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, reviewStatus: "approved", rejectReason: "", createdAt: "2026-01-15T00:00:00.000Z", repairedAt: null }
    ],
    batches: [],
    repairImages: [],
    batchSnapshots: []
  });
}

function seedOldFormatDb() {
  writeDb({
    rubbings: [
      { id: "r1", code: "TP-测试-001", source: "测试来源", paperSize: "30x40cm", createdAt: "2026-06-01T00:00:00.000Z" }
    ],
    damages: [
      { id: "d1", rubbingId: "r1", position: "测试位置", type: "测试类型", beforePhotoUrl: "test.jpg", status: "pending", createdAt: "2026-06-01T00:00:00.000Z" }
    ],
    batches: [],
    repairImages: []
  }, { raw: true });
}

function parseCsv(csvText) {
  const lines = csvText.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseLine = (line) => {
    const result = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        result.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    result.push(current);
    return result;
  };

  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

async function runTests() {
  console.log("\n=== 缺损审核模块测试 ===");

  console.log("\n【场景1】审核通过——验证审核人和审核时间被记录");
  seedReviewTestDb();
  await startServer();

  const approveRes = await httpRequest("POST", "/damages/d1/approve", { reviewedBy: "张审核员" });
  assertEqual(approveRes.status, 200, "审核通过返回 200");
  assertEqual(approveRes.body.data.reviewStatus, "approved", "审核状态变为 approved");
  assertEqual(approveRes.body.data.reviewedBy, "张审核员", "审核人正确记录为张审核员");
  assertNotNull(approveRes.body.data.reviewedAt, "审核时间已记录");
  assert(approveRes.body.data.reviewedAt && new Date(approveRes.body.data.reviewedAt).getTime() > 0, "审核时间是有效日期");

  await stopServer();

  console.log("\n【场景2】审核驳回——验证审核人和审核时间被记录");
  seedReviewTestDb();
  await startServer();

  const rejectRes = await httpRequest("POST", "/damages/d2/reject", { reason: "照片不清晰", reviewedBy: "李审核员" });
  assertEqual(rejectRes.status, 200, "审核驳回返回 200");
  assertEqual(rejectRes.body.data.reviewStatus, "rejected", "审核状态变为 rejected");
  assertEqual(rejectRes.body.data.rejectReason, "照片不清晰", "驳回原因正确记录");
  assertEqual(rejectRes.body.data.reviewedBy, "李审核员", "审核人正确记录为李审核员");
  assertNotNull(rejectRes.body.data.reviewedAt, "审核时间已记录");

  await stopServer();

  console.log("\n【场景3】审核通过未传审核人——验证使用默认值");
  seedReviewTestDb();
  await startServer();

  const approveDefaultRes = await httpRequest("POST", "/damages/d1/approve", {});
  assertEqual(approveDefaultRes.status, 200, "未传审核人也能审核通过");
  assertEqual(approveDefaultRes.body.data.reviewedBy, "系统审核", "默认审核人为系统审核");
  assertNotNull(approveDefaultRes.body.data.reviewedAt, "审核时间仍然被记录");

  await stopServer();

  console.log("\n【场景4】缺损列表接口——验证包含审核人和审核时间字段");
  seedReviewTestDb();
  await startServer();

  await httpRequest("POST", "/damages/d1/approve", { reviewedBy: "王审核" });
  await httpRequest("POST", "/damages/d2/reject", { reason: "测试驳回", reviewedBy: "赵审核" });

  const listRes = await httpRequest("GET", "/damages");
  assertEqual(listRes.status, 200, "缺损列表返回 200");
  assertEqual(listRes.body.data.length, 3, "返回3条缺损数据");

  const approvedDamage = listRes.body.data.find((d) => d.id === "d1");
  assert(approvedDamage && approvedDamage.reviewedBy === "王审核", "已通过的缺损包含审核人");
  assertNotNull(approvedDamage && approvedDamage.reviewedAt, "已通过的缺损包含审核时间");

  const rejectedDamage = listRes.body.data.find((d) => d.id === "d2");
  assert(rejectedDamage && rejectedDamage.reviewedBy === "赵审核", "已驳回的缺损包含审核人");
  assertNotNull(rejectedDamage && rejectedDamage.reviewedAt, "已驳回的缺损包含审核时间");

  const pendingDamage = listRes.body.data.find((d) => d.id === "d3");
  assertEqual(pendingDamage.reviewedBy, null, "未审核的缺损reviewedBy为null");
  assertEqual(pendingDamage.reviewedAt, null, "未审核的缺损reviewedAt为null");

  await stopServer();

  console.log("\n【场景5】拓片汇总接口——验证缺损包含审核人和审核时间");
  seedReviewTestDb();
  await startServer();

  await httpRequest("POST", "/damages/d1/approve", { reviewedBy: "陈审核" });

  const summaryRes = await httpRequest("GET", "/rubbings/r1/summary");
  assertEqual(summaryRes.status, 200, "拓片汇总返回 200");
  assert(summaryRes.body.data.damages.length > 0, "汇总包含缺损列表");

  const summaryDamage = summaryRes.body.data.damages.find((d) => d.id === "d1");
  assertEqual(summaryDamage.reviewedBy, "陈审核", "拓片汇总中缺损包含审核人");
  assertNotNull(summaryDamage.reviewedAt, "拓片汇总中缺损包含审核时间");

  await stopServer();

  console.log("\n【场景6】旧数据缺字段——验证读取不报错且有默认值");
  seedOldFormatDb();
  await startServer();

  const oldDataRes = await httpRequest("GET", "/damages");
  assertEqual(oldDataRes.status, 200, "旧数据读取返回 200");
  assertEqual(oldDataRes.body.data.length, 1, "返回1条旧数据");

  const oldDamage = oldDataRes.body.data[0];
  assertEqual(oldDamage.reviewStatus, "approved", "旧数据reviewStatus默认为approved");
  assertEqual(oldDamage.rejectReason, "", "旧数据rejectReason默认为空字符串");
  assertEqual(oldDamage.reviewedBy, null, "旧数据reviewedBy默认为null");
  assertEqual(oldDamage.reviewedAt, null, "旧数据reviewedAt默认为null");

  await stopServer();

  console.log("\n【场景7】缺少审核字段的待审核数据能正常审核通过");
  writeDb({
    rubbings: [
      { id: "r1", code: "TP-测试-001", source: "测试来源", paperSize: "30x40cm", createdAt: "2026-06-01T00:00:00.000Z" }
    ],
    damages: [
      { id: "d1", rubbingId: "r1", position: "测试位置", type: "测试类型", beforePhotoUrl: "test.jpg", status: "pending", reviewStatus: "review_pending", createdAt: "2026-06-01T00:00:00.000Z" }
    ],
    batches: [],
    repairImages: []
  });
  await startServer();

  const oldApproveRes = await httpRequest("POST", "/damages/d1/approve", { reviewedBy: "老数据审核员" });
  assertEqual(oldApproveRes.status, 200, "缺审核字段的待审核数据审核通过返回 200");
  assertEqual(oldApproveRes.body.data.reviewStatus, "approved", "审核后状态正确");
  assertEqual(oldApproveRes.body.data.reviewedBy, "老数据审核员", "审核后人已记录");
  assertNotNull(oldApproveRes.body.data.reviewedAt, "审核后时间已记录");

  await stopServer();

  console.log("\n【场景8】缺损项CSV导出——验证包含审核人和审核时间列");
  seedReviewTestDb();
  await startServer();

  await httpRequest("POST", "/damages/d1/approve", { reviewedBy: "CSV审核员" });
  await httpRequest("POST", "/damages/d2/reject", { reason: "CSV驳回原因", reviewedBy: "CSV审核员2" });

  const csvRes = await httpRequest("GET", "/export/damages");
  assertEqual(csvRes.status, 200, "缺损CSV导出返回 200");

  const csvParsed = parseCsv(csvRes.body);
  assert(csvParsed.headers.includes("审核人"), "CSV包含审核人列");
  assert(csvParsed.headers.includes("审核时间"), "CSV包含审核时间列");
  assertEqual(csvParsed.rows.length, 3, "CSV有3行数据");

  const reviewedByIdx = csvParsed.headers.indexOf("审核人");
  const reviewedAtIdx = csvParsed.headers.indexOf("审核时间");

  const d1Row = csvParsed.rows.find((row) => row.includes("d1"));
  assert(d1Row && d1Row[reviewedByIdx] === "CSV审核员", "CSV中d1的审核人正确");
  assert(d1Row && d1Row[reviewedAtIdx] !== "", "CSV中d1的审核时间非空");

  const d2Row = csvParsed.rows.find((row) => row.includes("d2"));
  assert(d2Row && d2Row[reviewedByIdx] === "CSV审核员2", "CSV中d2的审核人正确");

  const d3Row = csvParsed.rows.find((row) => row.includes("d3"));
  assert(d3Row && d3Row[reviewedByIdx] === "", "CSV中d3（无审核记录）的审核人为空");

  await stopServer();

  console.log("\n【场景9】旧数据CSV导出——验证缺字段时CSV结构稳定");
  seedOldFormatDb();
  await startServer();

  const oldCsvRes = await httpRequest("GET", "/export/damages");
  assertEqual(oldCsvRes.status, 200, "旧数据CSV导出返回 200");

  const oldCsvParsed = parseCsv(oldCsvRes.body);
  assert(oldCsvParsed.headers.includes("审核人"), "旧数据CSV仍包含审核人列");
  assert(oldCsvParsed.headers.includes("审核时间"), "旧数据CSV仍包含审核时间列");
  assertEqual(oldCsvParsed.rows.length, 1, "有1行数据");
  assertEqual(oldCsvParsed.rows[0].length, oldCsvParsed.headers.length, "每行列数与表头一致");

  const oldReviewedByIdx = oldCsvParsed.headers.indexOf("审核人");
  const oldReviewedAtIdx = oldCsvParsed.headers.indexOf("审核时间");
  assertEqual(oldCsvParsed.rows[0][oldReviewedByIdx], "", "旧数据审核人列为空");
  assertEqual(oldCsvParsed.rows[0][oldReviewedAtIdx], "", "旧数据审核时间列为空");

  await stopServer();

  console.log("\n【场景10】修补结果CSV导出——验证包含审核人和审核时间列");
  seedReviewTestDb();
  await startServer();

  await httpRequest("POST", "/damages/d1/approve", { reviewedBy: "结果审核员" });

  const resultsCsvRes = await httpRequest("GET", "/export/repair-results");
  assertEqual(resultsCsvRes.status, 200, "修补结果CSV导出返回 200");

  const resultsCsvParsed = parseCsv(resultsCsvRes.body);
  assert(resultsCsvParsed.headers.includes("审核人"), "修补结果CSV包含审核人列");
  assert(resultsCsvParsed.headers.includes("审核时间"), "修补结果CSV包含审核时间列");
  assert(resultsCsvParsed.headers.includes("审核状态"), "修补结果CSV包含审核状态列");

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
    console.error(err.stack);
    process.exit(1);
  } finally {
    await stopServer();
    restoreDb();
  }
}

main();
