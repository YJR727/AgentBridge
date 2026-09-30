// 测试入口。
//
// 用法：
//   node tools/run-tests.mjs              跑 tests/ 下全部 *.test.mjs
//   node tools/run-tests.mjs crypto ws    只跑文件名匹配的
//   node tests/crypto.test.mjs            单文件直跑（等价）
//
// 为什么不直接 `node --test tests/`：
//   Node 官方 runner 会为每个测试文件再 spawn 一层子进程并用**管道**读它的输出，
//   而在受限沙箱里"用管道捕获子进程输出"会直接 EPERM（实测 errno -4048）。
//   每个测试文件本身就是一个可直接执行的脚本（内部用 node:test 的 test()），
//   所以这里改成：一个文件一个子进程，stdout/stderr 重定向到**文件描述符**（沙箱允许），
//   跑完读回文件。既能拿到每个文件的 TAP 汇总，也能拿到真实退出码。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = path.join(ROOT, 'tests');

const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const files = fs
  .readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => (filters.length ? filters.some((o) => f.includes(o)) : true))
  .sort();

if (files.length === 0) {
  console.error('没有找到匹配的测试文件');
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-tests-'));
const started = Date.now();
let passTotal = 0;
let failTotal = 0;
const failedFiles = [];

for (const file of files) {
  const outFile = path.join(tmpDir, `${file}.out.txt`);
  const errFile = path.join(tmpDir, `${file}.err.txt`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');

  process.stdout.write(`\n# ${file}\n`);
  let child;
  try {
    child = spawnSync(process.execPath, [path.join(testsDir, file)], {
      cwd: ROOT,
      stdio: ['ignore', outFd, errFd],
      timeout: 300_000,
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }

  const stdout = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  const stderr = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '';
  fs.rmSync(outFile, { force: true });
  fs.rmSync(errFile, { force: true });

  // 直接把这个文件的输出转出来（TAP 风格：✔ / ✖ / ℹ tests N）
  process.stdout.write(stdout);
  if (stderr.trim()) process.stdout.write(stderr);

  const passLines = (stdout.match(/^✔ /gm) ?? []).length;
  const failLines = (stdout.match(/^✖ /gm) ?? []).length;
  // TAP 汇总行更权威，优先用它
  const m = /^ℹ pass (\d+)$/m.exec(stdout);
  const f = /^ℹ fail (\d+)$/m.exec(stdout);
  const passCount = m ? Number(m[1]) : passLines;
  const failCount = f ? Number(f[1]) : failLines;
  passTotal += passCount;
  failTotal += failCount;

  if (child?.error?.code === 'EPERM' || child?.error?.code === 'ETIMEDOUT') {
    process.stdout.write(`  ⚠ 子进程启动被沙箱拦住（${child.error.code}）：请直接运行 node tests/${file}\n`);
    failedFiles.push(file);
  } else if ((child?.status ?? 1) !== 0) {
    failedFiles.push(file);
  }
}

fs.rmSync(tmpDir, { recursive: true, force: true });

const ms = Date.now() - started;
const ok = failedFiles.length === 0 && failTotal === 0;
process.stdout.write(`\n${ok ? '✔' : '✖'} 合计：通过 ${passTotal} · 失败 ${failTotal} · 用时 ${ms} ms\n`);
if (!ok) {
  process.stdout.write(`  有问题的文件：${failedFiles.join('、') || '（见上面的失败用例）'}\n`);
}
process.exit(ok ? 0 : 1);
