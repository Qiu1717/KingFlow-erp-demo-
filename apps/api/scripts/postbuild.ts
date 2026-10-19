import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';

/**
 * 让编译产物真正可运行。
 *
 * API 的 TypeScript 编译会保留 `@kingflow/shared` 这个包名说明符，而该包在
 * node_modules 中是指向 `packages/shared` 的软链，其 `exports` 指向 `.ts` 源文件
 * （开发与测试由 tsx 直接执行 TypeScript）。因此直接 `node dist/.../server.js`
 * 会因为 Node 无法加载 `.ts` 而失败——`pnpm build` 产出的是一个跑不起来的产物。
 *
 * 这里在 tsc 之后把产物中的 `@kingflow/shared` 改写成指向同一份编译输出的相对路径，
 * 使 dist 自包含、可由纯 Node 启动，同时开发与测试继续直接执行源码，工作流不变。
 * 不引入新依赖，也不改变源码里的 import 写法。
 */

const apiRoot = resolve(import.meta.dirname, '..');
const distRoot = join(apiRoot, 'dist');
const sharedEntry = join(distRoot, 'packages/shared/src/index.js');

const walk = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
};

async function main() {
  if (!existsSync(distRoot)) throw new Error('缺少 dist，请先执行 tsc 构建');
  if (!existsSync(sharedEntry))
    throw new Error('缺少 @kingflow/shared 的编译输出，检查 tsconfig.build.json');
  const files = await walk(distRoot);
  let rewritten = 0;
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (!source.includes('@kingflow/shared')) continue;
    let target = relative(dirname(file), sharedEntry).replaceAll('\\', '/');
    if (!target.startsWith('.')) target = './' + target;
    const output = source
      .replaceAll("'@kingflow/shared'", `'${target}'`)
      .replaceAll('"@kingflow/shared"', `"${target}"`);
    if (output !== source) {
      await writeFile(file, output, 'utf8');
      rewritten += 1;
    }
  }
  console.log(`构建后处理完成：改写 ${rewritten} 个文件中的共享包引用`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
