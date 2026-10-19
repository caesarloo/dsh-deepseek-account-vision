// 发布前的包清单与 bundle 装配一致性闸门。
//
// 检查的是“发布物装进 profile 后能不能被 DSH 正确装配”，而不是插件逻辑：
//   1. package.json 的入口（main / exports["."]）在磁盘上存在；
//   2. dsh.bundle.patch 指向的 patch 文件存在，且包含在 npm 的 files 里
//      （漏进 files 会导致“包能装、启动时找不到 patch”）；
//   3. cordis.patch.yml 里 insert 的 name 必须等于本包名
//      （name 是 PACKAGE NAME；写错 = 安装后启动装配失败）；
//   4. engines.dsh 存在且非空（DSH 0.2.x 的兼容性门禁只认它；
//      没有合法范围时宿主会按 peerDependencies 判定，本包没有 peer 可判）。
//
// 本脚本只用 Node 内建模块，不解析完整 YAML——针对本仓库固定结构的 patch 文件做
// 最小行扫描，因此不会把 YAML 解析器的依赖带进发布物。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const fail = (message) => failures.push(message);

const manifestPath = join(repoRoot, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const packageName = manifest.name;
if (typeof packageName !== 'string' || packageName.trim() === '') fail('package.json 缺少 name');

/** 归一化 ./ 前缀与分隔符后再比较。 */
const entriesOf = (value) => {
    if (typeof value !== 'string' || value === '') return [];
    return [normalize(value.replace(/^\.\//, ''))];
};

function requireShippedEntry(label, value) {
    for (const entry of entriesOf(value)) {
        if (!existsSync(join(repoRoot, entry))) fail(`${label} 指向的文件不存在: ${value}`);
    }
}

requireShippedEntry('main', manifest.main);
requireShippedEntry('exports["."]', manifest.exports?.['.']);

const patch = manifest.dsh?.bundle?.patch;
if (typeof patch !== 'string' || patch === '') {
    fail('package.json 缺少 dsh.bundle.patch');
} else {
    const patchRel = normalize(patch.replace(/^\.\//, ''));
    if (!existsSync(join(repoRoot, patchRel))) {
        fail(`dsh.bundle.patch 指向的文件不存在: ${patch}`);
    } else {
        const files = Array.isArray(manifest.files) ? manifest.files.map((entry) => normalize(entry.replace(/^\.\//, ''))) : [];
        const shipped = files.some((entry) => patchRel === entry || patchRel.startsWith(`${entry}/`));
        if (!shipped) fail(`dsh.bundle.patch（${patchRel}）没有被 package.json 的 files 包含，发布物会缺 patch 文件`);
    }
}

const enginesDsh = manifest.engines?.dsh;
if (typeof enginesDsh !== 'string' || enginesDsh.trim() === '') {
    fail('package.json 缺少 engines.dsh（DSH 0.2.x 用它在装载时判定兼容性）');
}

/** 提取 cordis.patch.yml 中每个 insert 条目声明的 name。 */
function insertNames(text) {
    const names = [];
    let inInsert = false;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        if (/^\s*-\s*insert:\s*$/.test(line)) {
            inInsert = true;
            continue;
        }
        if (!inInsert) continue;
        // 回到顶层（下一个 patch 条目）即结束 insert 段。
        if (/^-\s/.test(line)) break;
        const match = /^\s*name:\s*(.+?)\s*$/.exec(line);
        if (match) names.push(match[1].replace(/^['"]|['"]$/g, ''));
    }
    return names;
}

if (typeof patch === 'string' && patch !== '' && existsSync(join(repoRoot, normalize(patch.replace(/^\.\//, ''))))) {
    const text = readFileSync(join(repoRoot, normalize(patch.replace(/^\.\//, ''))), 'utf8');
    const names = insertNames(text);
    if (names.length === 0) fail('cordis.patch.yml 没有找到 insert 条目的 name');
    for (const name of names) {
        if (name !== packageName) fail(`cordis.patch.yml 的 insert name "${name}" 与包名 "${packageName}" 不一致（name 必须是 PACKAGE NAME）`);
    }
    if (!/^\s*-\s*insert:\s*$/m.test(text)) fail('cordis.patch.yml 缺少 insert 段');
}

if (failures.length > 0) {
    for (const message of failures) console.error(`  ✗ ${message}`);
    console.error(`\n[check-manifest] 发现 ${failures.length} 个发布清单问题 —— 先修复再发布。`);
    process.exit(1);
}
console.log(`[check-manifest] ✓ ${packageName}@${manifest.version}：入口、bundle patch、files 与 engines.dsh 一致`);
