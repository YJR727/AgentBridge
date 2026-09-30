// 子进程辅助：在当前环境下安全地跑一个带 stdin/捕获输出的子进程。
//
// 背景（实测结论，别再踩一遍）：
//   Node 在受限沙箱（例如 DSH 的文件沙箱、Codex 的 Windows 沙箱）里
//   spawn 子进程并"用管道捕获输出"会失败：errno -4048 / code EPERM。
//   stdio: 'inherit' 和 stdio: 'ignore' 正常；把 stdout 重定向到"文件描述符"也正常；
//   但 stdio: 'pipe'（无论哪个方向）会 EPERM。
//
// 所以这里统一用：stdin 走临时文件、stdout 走临时文件、stderr 走 inherit。
// 结果与 spawnSync({ encoding: 'utf8' }) 一致：{ status, stdout, stderr }。
//
// 正常环境（没有沙箱限制）下直接调 child_process 也能跑，但用这个函数
// 可以让测试与自测脚本在任何环境里都表现一致。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * @param {string} command
 * @param {string[]} args
 * @param {object} [options]
 * @param {string} [options.input]      要写进子进程 stdin 的内容
 * @param {string} [options.cwd]
 * @param {object} [options.env]
 * @param {number} [options.timeout]
 * @returns {{status:number|null, stdout:string, stderr:string, error?:string}}
 */
export function runChild(command, args, { input = '', cwd = process.cwd(), env = process.env, timeout = 30_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-spawn-'));
  const inFile = path.join(dir, 'stdin.txt');
  const outFile = path.join(dir, 'stdout.txt');
  const errFile = path.join(dir, 'stderr.txt');
  fs.writeFileSync(inFile, input, 'utf8');

  const inFd = fs.openSync(inFile, 'r');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');

  let result;
  try {
    result = spawnSync(command, args, { cwd, env, stdio: [inFd, outFd, errFd], timeout });
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }

  const stdout = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  const stderr = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '';
  fs.rmSync(dir, { recursive: true, force: true });

  return {
    status: result.status,
    stdout,
    stderr,
    error: result.error ? `${result.error.code ?? ''} ${result.error.message}` : undefined,
  };
}
