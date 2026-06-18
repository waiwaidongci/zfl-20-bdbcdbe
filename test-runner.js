const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const testHelper = require("./test-helper");

const DB_FILE = testHelper.DB_FILE;
const AUDIT_LOG_FILE = testHelper.AUDIT_LOG_FILE;
const BACKUP_DIR = path.join(__dirname, "data", "backups");

const RUNNER_BACKUP_DB = path.join(__dirname, "data", "db.json.runner_backup");
const RUNNER_BACKUP_AUDIT = path.join(__dirname, "data", "audit-logs.json.runner_backup");
const RUNNER_BACKUP_DIR = path.join(__dirname, "data", ".runner_backups_snapshot");
const RUNNER_TEMP_FILES = [
  path.join(__dirname, "data", "db.json.concurrent_test_backup")
];

const TEST_FILES = [
  { file: "test-review.js", name: "缺损审核模块", description: "审核通过/驳回、旧数据兼容、CSV导出审核字段" },
  { file: "test-dashboard.js", name: "修补工作台看板", description: "看板统计、筛选聚合、负责人聚合" },
  { file: "test-schedule.js", name: "批次排程模块", description: "排程创建、日期范围筛选、状态筛选、冲突校验" },
  { file: "test-repair-images.js", name: "修补影像归档", description: "影像登记/查询、阶段校验、主图约束、批次归档影像" },
  { file: "test-export.js", name: "数据导出模块", description: "CSV导出、字段筛选、过滤条件、特殊字符转义" },
  { file: "test-batch-import.js", name: "批量导入流程", description: "预检不落库、确认落库、重复编号跳过、引用校验" },
  { file: "test-batch-rollback.js", name: "批次完成回滚", description: "回滚快照、重复完成、引用检查、归档影像清理" },
  { file: "test-partial-rollback.js", name: "批次部分回滚", description: "部分缺损回滚、连续回滚、引用冲突、审计日志" },
  { file: "test-partial-rollback-scheduling.js", name: "部分回滚后排程", description: "回滚后重新排程、缺损释放验证" },
  { file: "test-audit-logs.js", name: "审计日志扩展", description: "审核/归档/导入/备份审计、多维度筛选" },
  { file: "test-concurrent-writes.js", name: "并发写入与乐观锁", description: "并发创建缺损、并发完成批次、版本冲突保护" }
];

function printUsage() {
  console.log(`
古籍拓片缺损修补API — 本地验证入口
====================================

用法:
  node test-runner.js                     运行全部测试（默认顺序）
  node test-runner.js all                 同上，运行全部测试
  node test-runner.js <test-file>         运行单个测试文件
  node test-runner.js <file1> <file2> ... 运行指定的多个测试文件
  node test-runner.js --list              列出所有可用测试

选项:
  --keep-failure   测试失败时保留现场数据（不恢复备份）
                   也可通过环境变量 KEEP_FAILURE=1 启用
  --help, -h       显示此帮助信息

示例:
  node test-runner.js test-review.js
  node test-runner.js test-dashboard.js test-schedule.js
  node test-runner.js all --keep-failure
  KEEP_FAILURE=1 node test-runner.js test-audit-logs.js
`);
}

function listTests() {
  console.log("\n可用测试列表:");
  console.log("=".repeat(90));
  console.log(`${"文件名".padEnd(38)} ${"模块名称".padEnd(22)} 描述`);
  console.log("-".repeat(90));
  for (const t of TEST_FILES) {
    const exists = fs.existsSync(path.join(__dirname, t.file)) ? "" : " (文件缺失!)";
    console.log(`${(t.file + exists).padEnd(38)} ${t.name.padEnd(22)} ${t.description}`);
  }
  console.log("=".repeat(90));
  console.log(`共 ${TEST_FILES.length} 个测试模块\n`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    targets: [],
    keepFailure: false,
    list: false,
    help: false
  };

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--list") {
      opts.list = true;
    } else if (arg === "--keep-failure") {
      opts.keepFailure = true;
    } else if (arg === "all") {
      opts.targets = TEST_FILES.map((t) => t.file);
    } else {
      opts.targets.push(arg);
    }
  }

  if (process.env.KEEP_FAILURE === "1") {
    opts.keepFailure = true;
  }

  if (opts.targets.length === 0 && !opts.list && !opts.help) {
    opts.targets = TEST_FILES.map((t) => t.file);
  }

  return opts;
}

function validateTargets(targets) {
  const validFiles = TEST_FILES.map((t) => t.file);
  const errors = [];

  for (const target of targets) {
    const fileName = target.endsWith(".js") ? target : `${target}.js`;
    if (!validFiles.includes(fileName)) {
      errors.push(`未知测试文件: ${target}`);
    }
    const fullPath = path.join(__dirname, fileName);
    if (!fs.existsSync(fullPath)) {
      errors.push(`测试文件不存在: ${fileName}`);
    }
  }

  return errors;
}

function normalizeTarget(target) {
  return target.endsWith(".js") ? target : `${target}.js`;
}

function getTestInfo(fileName) {
  return TEST_FILES.find((t) => t.file === fileName) || { file: fileName, name: fileName, description: "" };
}

function runnerBackup() {
  try {
    if (fs.existsSync(DB_FILE)) {
      fs.copyFileSync(DB_FILE, RUNNER_BACKUP_DB);
    }
    if (fs.existsSync(AUDIT_LOG_FILE)) {
      fs.copyFileSync(AUDIT_LOG_FILE, RUNNER_BACKUP_AUDIT);
    }
    if (fs.existsSync(RUNNER_BACKUP_DIR)) {
      fs.rmSync(RUNNER_BACKUP_DIR, { recursive: true, force: true });
    }
    if (fs.existsSync(BACKUP_DIR)) {
      fs.cpSync(BACKUP_DIR, RUNNER_BACKUP_DIR, { recursive: true });
    }
    return true;
  } catch (e) {
    console.error(`[runner] 备份失败: ${e.message}`);
    return false;
  }
}

function runnerRestore() {
  try {
    if (fs.existsSync(RUNNER_BACKUP_DB)) {
      const tempFile = path.join(path.dirname(DB_FILE), `.db_runner_restore_${Date.now()}.json`);
      fs.copyFileSync(RUNNER_BACKUP_DB, tempFile);
      fs.renameSync(tempFile, DB_FILE);
      try { fs.unlinkSync(RUNNER_BACKUP_DB); } catch (_) {}
    }
    if (fs.existsSync(RUNNER_BACKUP_AUDIT)) {
      fs.copyFileSync(RUNNER_BACKUP_AUDIT, AUDIT_LOG_FILE);
      try { fs.unlinkSync(RUNNER_BACKUP_AUDIT); } catch (_) {}
    }
    if (fs.existsSync(RUNNER_BACKUP_DIR)) {
      fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
      fs.cpSync(RUNNER_BACKUP_DIR, BACKUP_DIR, { recursive: true });
      fs.rmSync(RUNNER_BACKUP_DIR, { recursive: true, force: true });
    }
    for (const file of RUNNER_TEMP_FILES) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
    return true;
  } catch (e) {
    console.error(`[runner] 恢复失败: ${e.message}`);
    return false;
  }
}

function runnerCleanupBackup() {
  try {
    if (fs.existsSync(RUNNER_BACKUP_DB)) fs.unlinkSync(RUNNER_BACKUP_DB);
    if (fs.existsSync(RUNNER_BACKUP_AUDIT)) fs.unlinkSync(RUNNER_BACKUP_AUDIT);
    if (fs.existsSync(RUNNER_BACKUP_DIR)) fs.rmSync(RUNNER_BACKUP_DIR, { recursive: true, force: true });
    for (const file of RUNNER_TEMP_FILES) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  } catch (_) {}
}

function runSingleTest(fileName, index, total) {
  return new Promise((resolve) => {
    const info = getTestInfo(fileName);
    const header = `\n${"=".repeat(70)}\n[${index + 1}/${total}] 运行: ${fileName} — ${info.name}\n${info.description ? "        " + info.description + "\n" : ""}${"=".repeat(70)}`;
    console.log(header);

    const startTime = Date.now();
    const child = spawn("node", [fileName], {
      cwd: __dirname,
      env: { ...process.env },
      stdio: "inherit"
    });

    child.on("close", (code) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      const success = code === 0;
      const statusIcon = success ? "✅" : "❌";
      const statusText = success ? "PASS" : "FAIL";
      console.log(`\n${statusIcon} [${index + 1}/${total}] ${fileName} ${statusText}  (${duration}s, exit=${code})`);
      resolve({ fileName, name: info.name, success, code, duration });
    });

    child.on("error", (err) => {
      console.error(`[runner] 启动子进程失败: ${err.message}`);
      resolve({ fileName, name: info.name, success: false, code: -1, duration: 0, error: err.message });
    });
  });
}

function printSummary(results) {
  const passed = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  const totalDuration = results.reduce((sum, r) => sum + Number(r.duration), 0).toFixed(2);

  console.log(`\n${"=".repeat(70)}`);
  console.log("测试总结");
  console.log("=".repeat(70));
  console.log(`  总数:   ${results.length}`);
  console.log(`  通过:   ${passed.length}  ${passed.length > 0 ? "✅" : ""}`);
  console.log(`  失败:   ${failed.length}  ${failed.length > 0 ? "❌" : ""}`);
  console.log(`  总耗时: ${totalDuration}s`);
  console.log("-".repeat(70));

  for (const r of results) {
    const icon = r.success ? "✅" : "❌";
    console.log(`  ${icon} ${r.fileName.padEnd(36)} ${r.name.padEnd(20)} ${r.duration}s`);
  }

  if (failed.length > 0) {
    console.log("-".repeat(70));
    console.log("失败列表:");
    for (const r of failed) {
      console.log(`  ❌ ${r.fileName} — ${r.name}`);
    }
  }

  console.log("=".repeat(70));
}

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.help) {
    printUsage();
    process.exit(0);
  }

  if (opts.list) {
    listTests();
    process.exit(0);
  }

  const targetErrors = validateTargets(opts.targets);
  if (targetErrors.length > 0) {
    console.error("参数错误:");
    for (const e of targetErrors) console.error(`  - ${e}`);
    console.error("\n使用 --list 查看所有可用测试，使用 --help 查看帮助");
    process.exit(2);
  }

  const normalizedTargets = opts.targets.map(normalizeTarget);

  console.log(`\n🏛️  古籍拓片缺损修补API — 本地验证入口`);
  console.log(`测试目标: ${normalizedTargets.length} 个模块`);
  if (opts.keepFailure) {
    console.log(`⚠️   失败保留模式: 测试失败时不会自动恢复数据，便于排查问题`);
  }
  console.log(`备份文件: ${path.relative(__dirname, RUNNER_BACKUP_DB)}`);
  console.log(`备份目录快照: ${path.relative(__dirname, RUNNER_BACKUP_DIR)}`);

  const results = [];
  let hasFailure = false;
  let backupOk = false;

  try {
    console.log("\n[runner] 正在备份 db.json 和 audit-logs.json ...");
    backupOk = runnerBackup();
    if (!backupOk) {
      console.error("[runner] 数据备份失败，终止测试");
      process.exit(3);
    }
    console.log("[runner] 备份完成 ✓");

    for (let i = 0; i < normalizedTargets.length; i++) {
      const result = await runSingleTest(normalizedTargets[i], i, normalizedTargets.length);
      results.push(result);
      if (!result.success) {
        hasFailure = true;
      }
    }

    printSummary(results);

    if (hasFailure) {
      if (opts.keepFailure) {
        console.log("\n⚠️   失败保留模式已启用：现场数据未恢复。");
        console.log(`    db.json 备份在: ${path.relative(__dirname, RUNNER_BACKUP_DB)}`);
        console.log(`    audit-logs.json 备份在: ${path.relative(__dirname, RUNNER_BACKUP_AUDIT)}`);
        console.log(`    backups 目录快照在: ${path.relative(__dirname, RUNNER_BACKUP_DIR)}`);
        console.log(`    手动恢复请执行: node test-runner.js --restore`);
      } else {
        console.log("\n[runner] 检测到失败，正在恢复原始数据 ...");
        runnerRestore();
        console.log("[runner] 原始数据已恢复 ✓");
      }
      process.exit(1);
    } else {
      console.log("\n🎉  所有测试通过！正在恢复原始数据 ...");
      runnerRestore();
      console.log("[runner] 原始数据已恢复 ✓\n");
      process.exit(0);
    }
  } catch (err) {
    console.error(`\n[runner] 运行异常: ${err.message}`);
    console.error(err.stack);
    if (backupOk) {
      if (opts.keepFailure) {
        console.log("\n⚠️   失败保留模式：保留现场数据不恢复");
      } else {
        console.log("[runner] 尝试恢复原始数据 ...");
        runnerRestore();
        console.log("[runner] 原始数据已恢复 ✓");
      }
    }
    process.exit(4);
  }
}

if (process.argv.includes("--restore")) {
  console.log("[runner] 手动恢复模式 ...");
  if (fs.existsSync(RUNNER_BACKUP_DB) || fs.existsSync(RUNNER_BACKUP_AUDIT) || fs.existsSync(RUNNER_BACKUP_DIR)) {
    runnerRestore();
    console.log("[runner] 数据已恢复 ✓");
  } else {
    console.log("[runner] 未找到 runner 备份文件，无需恢复");
  }
  process.exit(0);
}

if (process.argv.includes("--clean-backup")) {
  console.log("[runner] 清理 runner 备份文件 ...");
  runnerCleanupBackup();
  console.log("[runner] 清理完成 ✓");
  process.exit(0);
}

main();
