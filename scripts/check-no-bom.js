// 检查源码文件是否带 UTF-8 BOM。
// Windows 编辑器可能悄悄加 BOM：ESM 入口文件带 BOM 时 Node 能解析，但
// 部分工具链（以及 DSH 的插件装载诊断）会把首行当作语法错误；统一禁止。
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_DIRS = ['lib', 'tests', 'scripts'];
const TARGET_FILES = ['package.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md'];
const EXTENSIONS = new Set(['.js', '.mjs', '.json', '.yml', '.md']);

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      yield* walk(full);
    } else if (EXTENSIONS.has(extname(entry.name))) {
      yield full;
    }
  }
}

const files = [];
for (const dir of TARGET_DIRS) {
  for await (const file of walk(join(ROOT, dir))) files.push(file);
}
for (const file of TARGET_FILES) files.push(join(ROOT, file));

let failed = 0;
for (const file of files) {
  const bytes = await readFile(file).catch(() => undefined);
  if (bytes === undefined) continue;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    failed += 1;
    console.error(`BOM found: ${file}`);
  }
}
if (failed > 0) {
  console.error(`${failed} file(s) start with a UTF-8 BOM`);
  process.exitCode = 1;
} else {
  console.log(`checked ${files.length} file(s): no BOM`);
}
