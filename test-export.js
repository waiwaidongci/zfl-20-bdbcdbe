const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const testHelper = require("./test-helper");

const BACKUP_FILE = path.join(__dirname, "data", "db.json.exportbackup");
const CONFIGURED_PORT = process.env.TEST_EXPORT_PORT ? Number(process.env.TEST_EXPORT_PORT) : null;

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

function httpRequestCsv(method, pathname) {
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
        resolve({ status: res.statusCode, body: data, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function getDecodedContentDispositionFilename(header) {
  const match = /filename\*=UTF-8''([^;]+)/.exec(header || "");
  return match ? decodeURIComponent(match[1]) : header || "";
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

function seedMultiBatchDb() {
  writeDb({
    rubbings: [
      { id: "r1", code: "TP-清-014", source: "地方碑刻残页", paperSize: "42x68cm", note: "边缘有旧折痕", createdAt: "2026-01-15T00:00:00.000Z" },
      { id: "r2", code: "TP-明-007", source: "明代墓志拓片", paperSize: "60x90cm", note: "", createdAt: "2026-02-20T00:00:00.000Z" },
      { id: "r3", code: "TP-宋-023", source: "宋代摩崖石刻", paperSize: "80x120cm", note: "大面积风化", createdAt: "2026-03-10T00:00:00.000Z" }
    ],
    damages: [
      { id: "d1", rubbingId: "r1", position: "左上角", type: "虫蛀孔", beforePhotoUrl: "x.jpg", afterPhotoUrl: "a1.jpg", status: "repaired", repairNote: "使用日本和纸修补", batchId: "b1", createdAt: "2026-01-16T00:00:00.000Z", repairedAt: "2026-06-10T00:00:00.000Z", reviewStatus: "approved", rejectReason: "" },
      { id: "d2", rubbingId: "r1", position: "下边缘", type: "撕裂", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "in_repair", repairNote: "", batchId: "b1", createdAt: "2026-01-16T00:00:00.000Z", repairedAt: null, reviewStatus: "approved", rejectReason: "" },
      { id: "d3", rubbingId: "r2", position: "中央区域", type: "霉斑", beforePhotoUrl: "x.jpg", afterPhotoUrl: "a3.jpg", status: "repaired", repairNote: "化学去霉处理", batchId: "b2", createdAt: "2026-02-21T00:00:00.000Z", repairedAt: "2026-06-12T00:00:00.000Z", reviewStatus: "approved", rejectReason: "" },
      { id: "d4", rubbingId: "r2", position: "右上角", type: "虫蛀孔", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: "2026-02-21T00:00:00.000Z", repairedAt: null, reviewStatus: "review_pending", rejectReason: "" },
      { id: "d5", rubbingId: "r3", position: "左侧1/3处", type: "风化缺损", beforePhotoUrl: "x.jpg", afterPhotoUrl: "", status: "in_repair", repairNote: "", batchId: "b2", createdAt: "2026-03-11T00:00:00.000Z", repairedAt: null, reviewStatus: "approved", rejectReason: "" },
      { id: "d6", rubbingId: "r3", position: "底部边缘", type: "撕裂", beforePhotoUrl: "x.jpg", afterPhotoUrl: "a6.jpg", status: "repaired", repairNote: "托裱加固", batchId: "b1", createdAt: "2026-03-11T00:00:00.000Z", repairedAt: "2026-06-11T00:00:00.000Z", reviewStatus: "rejected", rejectReason: "修补颜色偏差较大" }
    ],
    batches: [
      { id: "b1", name: "六月第一批修补", status: "completed", damageIds: ["d1", "d2", "d6"], note: "重点处理虫蛀和撕裂问题", createdAt: "2026-06-01T00:00:00.000Z", completedAt: "2026-06-15T00:00:00.000Z", plannedStartAt: "2026-06-05T00:00:00.000Z", plannedEndAt: "2026-06-20T00:00:00.000Z", responsible: "张师傅" },
      { id: "b2", name: "六月第二批修补", status: "open", damageIds: ["d3", "d5"], note: "处理霉斑和风化", createdAt: "2026-06-08T00:00:00.000Z", completedAt: null, plannedStartAt: "2026-06-10T00:00:00.000Z", plannedEndAt: "2026-06-25T00:00:00.000Z", responsible: "李师傅" }
    ],
    repairImages: [
      { id: "img1", damageId: "d1", stage: "before_repair", url: "https://example.com/b1.jpg", capturedAt: "2026-06-05T00:00:00.000Z", description: "修补前虫蛀孔", collector: "张师傅", createdAt: "2026-06-05T00:00:00.000Z" },
      { id: "img2", damageId: "d1", stage: "after_repair", url: "https://example.com/a1.jpg", capturedAt: "2026-06-10T00:00:00.000Z", description: "修补后效果", collector: "张师傅", createdAt: "2026-06-10T00:00:00.000Z" },
      { id: "img3", damageId: "d3", stage: "before_repair", url: "https://example.com/b3.jpg", capturedAt: "2026-06-10T00:00:00.000Z", description: "修补前霉斑", collector: "李师傅", createdAt: "2026-06-10T00:00:00.000Z" },
      { id: "img4", damageId: "d3", stage: "during_repair", url: "https://example.com/d3.jpg", capturedAt: "2026-06-11T00:00:00.000Z", description: "去霉处理中", collector: "李师傅", createdAt: "2026-06-11T00:00:00.000Z" },
      { id: "img5", damageId: "d3", stage: "after_repair", url: "https://example.com/a3.jpg", capturedAt: "2026-06-12T00:00:00.000Z", description: "修补完成", collector: "李师傅", createdAt: "2026-06-12T00:00:00.000Z" }
    ]
  });
}

function seedEmptyDb() {
  writeDb({
    rubbings: [],
    damages: [],
    batches: [],
    repairImages: []
  });
}

function seedMissingFieldsDb() {
  writeDb({
    rubbings: [
      { id: "r1", code: "TP-测试-001", source: "测试来源", paperSize: "30x40cm", createdAt: "2026-06-01T00:00:00.000Z" }
    ],
    damages: [
      { id: "d1", rubbingId: "r1", position: "测试位置", type: "测试类型", beforePhotoUrl: "test.jpg", status: "pending", createdAt: "2026-06-01T00:00:00.000Z" }
    ],
    batches: [],
    repairImages: []
  });
}

async function runTests() {
  console.log("\n=== 数据导出模块测试 ===");

  console.log("\n【场景1】health 接口包含导出路由");
  seedMultiBatchDb();
  await startServer();

  const healthRes = await httpRequestCsv("GET", "/health");
  const healthBody = JSON.parse(healthRes.body);
  assert(healthBody.routes.includes("GET /export/rubbings?startDate=&endDate="), "包含 GET /export/rubbings");
  assert(healthBody.routes.includes("GET /export/damages?status=&type=&startDate=&endDate="), "包含 GET /export/damages");
  assert(healthBody.routes.includes("GET /export/batches?status=&startDate=&endDate="), "包含 GET /export/batches");
  assert(healthBody.routes.includes("GET /export/repair-results?status=&type=&startDate=&endDate="), "包含 GET /export/repair-results");

  await stopServer();

  console.log("\n【场景2】拓片CSV导出——验证中文内容和结构");
  seedMultiBatchDb();
  await startServer();

  const rubbingsRes = await httpRequestCsv("GET", "/export/rubbings");
  assertEqual(rubbingsRes.status, 200, "拓片导出返回 200");
  assertEqual(rubbingsRes.headers["content-type"], "text/csv; charset=utf-8", "Content-Type 为 text/csv");
  assert(getDecodedContentDispositionFilename(rubbingsRes.headers["content-disposition"]).includes("拓片数据"), "文件名包含中文");
  assert(rubbingsRes.body.startsWith("\uFEFF"), "包含 BOM 以支持 Excel 中文显示");

  const rubbingsParsed = parseCsv(rubbingsRes.body);
  assertEqual(rubbingsParsed.headers.length, 10, "拓片CSV有10列");
  assertEqual(rubbingsParsed.headers[0], "拓片ID", "第一列标题为拓片ID");
  assertEqual(rubbingsParsed.headers[1], "拓片编号", "第二列标题为拓片编号");
  assertEqual(rubbingsParsed.headers[2], "来源", "第三列标题为来源");
  assertEqual(rubbingsParsed.rows.length, 3, "导出3条拓片数据");
  assert(rubbingsParsed.rows.some((row) => row.includes("TP-清-014")), "包含拓片编号 TP-清-014");
  assert(rubbingsParsed.rows.some((row) => row.includes("地方碑刻残页")), "包含中文来源");

  await stopServer();

  console.log("\n【场景3】缺损项CSV导出——验证可读名称替代ID");
  seedMultiBatchDb();
  await startServer();

  const damagesRes = await httpRequestCsv("GET", "/export/damages");
  assertEqual(damagesRes.status, 200, "缺损项导出返回 200");

  const damagesParsed = parseCsv(damagesRes.body);
  assertEqual(damagesParsed.headers.length, 14, "缺损项CSV有14列");
  assert(damagesParsed.headers.includes("拓片编号"), "包含拓片编号列");
  assert(damagesParsed.headers.includes("所属批次"), "包含所属批次列");
  assert(damagesParsed.headers.includes("修补状态"), "包含修补状态列");
  assert(damagesParsed.headers.includes("审核状态"), "包含审核状态列");
  assertEqual(damagesParsed.rows.length, 6, "导出6条缺损项数据");

  const rowWithBatch = damagesParsed.rows.find((row) => row.includes("d1"));
  assert(rowWithBatch && rowWithBatch.includes("TP-清-014"), "包含可读拓片编号而非ID");
  assert(rowWithBatch && rowWithBatch.includes("六月第一批修补"), "包含可读批次名称而非ID");
  assert(rowWithBatch && rowWithBatch.includes("已修补"), "状态显示为中文");

  await stopServer();

  console.log("\n【场景4】批次CSV导出——验证多批次数据");
  seedMultiBatchDb();
  await startServer();

  const batchesRes = await httpRequestCsv("GET", "/export/batches");
  assertEqual(batchesRes.status, 200, "批次导出返回 200");

  const batchesParsed = parseCsv(batchesRes.body);
  assertEqual(batchesParsed.headers.length, 13, "批次CSV有13列");
  assertEqual(batchesParsed.rows.length, 2, "导出2条批次数据");
  assert(batchesParsed.rows.some((row) => row.includes("六月第一批修补")), "包含第一批");
  assert(batchesParsed.rows.some((row) => row.includes("六月第二批修补")), "包含第二批");
  assert(batchesParsed.rows.some((row) => row.includes("已完成")), "状态显示已完成");
  assert(batchesParsed.rows.some((row) => row.includes("进行中")), "状态显示进行中");

  await stopServer();

  console.log("\n【场景5】修补结果CSV导出——验证影像统计");
  seedMultiBatchDb();
  await startServer();

  const resultsRes = await httpRequestCsv("GET", "/export/repair-results");
  assertEqual(resultsRes.status, 200, "修补结果导出返回 200");

  const resultsParsed = parseCsv(resultsRes.body);
  assertEqual(resultsParsed.headers.length, 15, "修补结果CSV有15列");
  assert(resultsParsed.headers.includes("修补前影像数"), "包含修补前影像数列");
  assert(resultsParsed.headers.includes("修补中影像数"), "包含修补中影像数列");
  assert(resultsParsed.headers.includes("修补后影像数"), "包含修补后影像数列");

  const d3Row = resultsParsed.rows.find((row) => row.includes("d3"));
  const d3BeforeIdx = resultsParsed.headers.indexOf("修补前影像数");
  const d3DuringIdx = resultsParsed.headers.indexOf("修补中影像数");
  const d3AfterIdx = resultsParsed.headers.indexOf("修补后影像数");
  assert(d3Row && d3Row[d3BeforeIdx] === "1", "d3修补前影像数为1");
  assert(d3Row && d3Row[d3DuringIdx] === "1", "d3修补中影像数为1");
  assert(d3Row && d3Row[d3AfterIdx] === "1", "d3修补后影像数为1");

  await stopServer();

  console.log("\n【场景6】按状态过滤导出");
  seedMultiBatchDb();
  await startServer();

  const filteredDamagesRes = await httpRequestCsv("GET", "/export/damages?status=repaired");
  const filteredParsed = parseCsv(filteredDamagesRes.body);
  assertEqual(filteredParsed.rows.length, 3, "按repaired过滤后有3条数据");
  assert(filteredParsed.rows.every((row) => row.includes("已修补")), "所有行状态都是已修补");

  await stopServer();

  console.log("\n【场景7】按缺损类型过滤导出");
  seedMultiBatchDb();
  await startServer();

  const typeFilteredRes = await httpRequestCsv("GET", "/export/damages?type=虫蛀孔");
  const typeParsed = parseCsv(typeFilteredRes.body);
  assertEqual(typeParsed.rows.length, 2, "按虫蛀孔过滤后有2条数据");
  assert(typeParsed.rows.every((row) => row.includes("虫蛀孔")), "所有行类型都是虫蛀孔");

  await stopServer();

  console.log("\n【场景8】按创建时间范围过滤导出");
  seedMultiBatchDb();
  await startServer();

  const dateFilteredRes = await httpRequestCsv("GET", "/export/rubbings?startDate=2026-02-01&endDate=2026-02-28");
  const dateParsed = parseCsv(dateFilteredRes.body);
  assertEqual(dateParsed.rows.length, 1, "按2月时间范围过滤后有1条数据");
  assert(dateParsed.rows[0].includes("TP-明-007"), "是2月创建的拓片");

  await stopServer();

  console.log("\n【场景9】组合过滤——状态+类型+时间");
  seedMultiBatchDb();
  await startServer();

  const combinedRes = await httpRequestCsv("GET", "/export/repair-results?status=repaired&type=虫蛀孔&startDate=2026-01-01&endDate=2026-06-30");
  const combinedParsed = parseCsv(combinedRes.body);
  assertEqual(combinedParsed.rows.length, 1, "组合过滤后有1条数据");
  assert(combinedParsed.rows[0].includes("d1"), "是d1缺损项");

  await stopServer();

  console.log("\n【场景10】空数据库导出——验证CSV结构稳定性");
  seedEmptyDb();
  await startServer();

  const emptyRubbingsRes = await httpRequestCsv("GET", "/export/rubbings");
  const emptyRubbingsParsed = parseCsv(emptyRubbingsRes.body);
  assertEqual(emptyRubbingsParsed.headers.length, 10, "空结果仍有10列表头");
  assertEqual(emptyRubbingsParsed.rows.length, 0, "空结果没有数据行");

  const emptyDamagesRes = await httpRequestCsv("GET", "/export/damages");
  const emptyDamagesParsed = parseCsv(emptyDamagesRes.body);
  assertEqual(emptyDamagesParsed.headers.length, 14, "空缺损结果仍有14列表头");

  const emptyBatchesRes = await httpRequestCsv("GET", "/export/batches");
  const emptyBatchesParsed = parseCsv(emptyBatchesRes.body);
  assertEqual(emptyBatchesParsed.headers.length, 13, "空批次结果仍有13列表头");

  const emptyResultsRes = await httpRequestCsv("GET", "/export/repair-results");
  const emptyResultsParsed = parseCsv(emptyResultsRes.body);
  assertEqual(emptyResultsParsed.headers.length, 15, "空修补结果仍有15列表头");

  await stopServer();

  console.log("\n【场景11】字段缺失时CSV结构稳定");
  seedMissingFieldsDb();
  await startServer();

  const missingRes = await httpRequestCsv("GET", "/export/damages");
  const missingParsed = parseCsv(missingRes.body);
  assertEqual(missingParsed.headers.length, 14, "字段缺失时仍有14列");
  assertEqual(missingParsed.rows.length, 1, "有1条数据");
  assertEqual(missingParsed.rows[0].length, 14, "每行仍有14列");

  const reviewIdx = missingParsed.headers.indexOf("审核状态");
  const batchIdx = missingParsed.headers.indexOf("所属批次");
  assertEqual(missingParsed.rows[0][reviewIdx], "", "缺失reviewStatus时保持空字段");
  assertEqual(missingParsed.rows[0][batchIdx], "", "缺失batchId时空字符串");

  await stopServer();

  console.log("\n【场景12】CSV特殊字符转义——逗号和引号");
  writeDb({
    rubbings: [
      { id: "r1", code: "TP,测试-001", source: '测试"来源"', paperSize: "30x40cm", note: "备注,包含,逗号", createdAt: "2026-06-01T00:00:00.000Z" }
    ],
    damages: [],
    batches: [],
    repairImages: []
  });
  await startServer();

  const specialRes = await httpRequestCsv("GET", "/export/rubbings");
  const specialParsed = parseCsv(specialRes.body);
  assertEqual(specialParsed.rows.length, 1, "正确解析1条数据");
  assert(specialParsed.rows[0].includes("TP,测试-001"), "正确解析包含逗号的字段");
  assert(specialParsed.rows[0].includes('测试"来源"'), "正确解析包含引号的字段");
  assert(specialParsed.rows[0].includes("备注,包含,逗号"), "正确解析多逗号字段");

  await stopServer();

  console.log("\n【场景13】按批次状态过滤");
  seedMultiBatchDb();
  await startServer();

  const completedBatchesRes = await httpRequestCsv("GET", "/export/batches?status=completed");
  const completedParsed = parseCsv(completedBatchesRes.body);
  assertEqual(completedParsed.rows.length, 1, "按completed过滤后有1条数据");
  assert(completedParsed.rows[0].includes("已完成"), "状态为已完成");

  const openBatchesRes = await httpRequestCsv("GET", "/export/batches?status=open");
  const openParsed = parseCsv(openBatchesRes.body);
  assertEqual(openParsed.rows.length, 1, "按open过滤后有1条数据");
  assert(openParsed.rows[0].includes("进行中"), "状态为进行中");

  await stopServer();

  console.log("\n【场景14】修补结果按修补完成时间过滤");
  seedMultiBatchDb();
  await startServer();

  const repairDateRes = await httpRequestCsv("GET", "/export/repair-results?startDate=2026-06-10&endDate=2026-06-11");
  const repairDateParsed = parseCsv(repairDateRes.body);
  assertEqual(repairDateParsed.rows.length, 2, "按完成时间过滤后有2条数据");
  assert(repairDateParsed.rows.some((row) => row.includes("d1")), "包含d1");
  assert(repairDateParsed.rows.some((row) => row.includes("d6")), "包含d6");

  await stopServer();

  console.log("\n【场景15】驳回原因和特殊中文内容验证");
  seedMultiBatchDb();
  await startServer();

  const rejectRes = await httpRequestCsv("GET", "/export/damages?status=repaired");
  const rejectParsed = parseCsv(rejectRes.body);
  const d6Row = rejectParsed.rows.find((row) => row.includes("d6"));
  const rejectIdx = rejectParsed.headers.indexOf("驳回原因");
  assert(d6Row && d6Row[rejectIdx] === "修补颜色偏差较大", "正确导出驳回原因中文内容");

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
