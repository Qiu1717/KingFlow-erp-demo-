/* global process, console */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 用工作区内的临时目录运行子命令。
 *
 * esbuild 会把中间产物写到系统临时目录再删除；在 Windows 上若临时目录受
 * 受管策略/杀毒软件限制，删除会被拒绝并让整个构建失败（Access is denied）。
 * 把 TMPDIR/TEMP/TMP 指向工作区内目录即可绕开，且不改变构建产物本身。
 *
 * 用法：node scripts/with-local-temp.mjs <command> [...args]
 */
const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('用法：node scripts/with-local-temp.mjs <command> [...args]');
  process.exit(2);
}

const root = resolve(import.meta.dirname, '..');
const temp = join(root, '.tmp-build');
mkdirSync(temp, { recursive: true });

const child = spawn(command, args, {
  stdio: 'inherit',
  env: { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp },
  shell: process.platform === 'win32',
});

child.on('exit', (code, signal) => {
  rmSync(temp, { recursive: true, force: true });
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
