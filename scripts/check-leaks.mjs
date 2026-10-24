// 发布前泄漏防线：源码 / 测试 / 脚本 / README / 配置一律不得含本机指纹。
//
// 为什么需要它：这类问题只能靠人记得查，而实践已经证明人会漏——发布物一旦推上
// 公开仓库与 npm，指纹会同时留在**全历史**与**各版本 tarball** 里。
//
// 规则刻意**自足**，不依赖任何外部脚本或技能（发布闸门不该在“运行者机器上恰好
// 装了某个技能”时才生效），分三类：
//   ① 从运行环境推导的本机指纹——当前用户名 / 家目录 / 计算机名 / 云盘同步根目录名；
//      它们不写死在源码里（写了就自相矛盾：扫描器自己成了泄漏源），一律运行时取。
//   ② 与机器无关的形态规则——家目录式绝对路径、带端口的回环地址、内网 IP、
//      云盘厂商词、“规模类计数”（`N 个插件` 这类会暴露本机资产数量的说法）、
//      以及常见凭据形态（私钥块、npm / GitHub token）。
//   ③ 由调用方补充的本机专属模式，来自 .gitignore 的 `.leak-patterns.local`
//      （组织名、约定目录名等）——该文件不进版本库，所以扫描器与被扫仓库都不必写出这些词。
//
// 注意：匹配**大小写敏感**（JS RegExp 默认如此）。刻意不开 `i`——否则英文里形如
// "xxx-only" 的小写短语会被主机名前缀规则误伤。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// 工作区根目录 = 本仓库的上一级。运行时推导，故源码里没有这个路径的字面量。
const workspaceRoot = dirname(repoRoot);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 本机专属模式：一行一条正则，`#` 开头为注释，文件本身不进版本库（见 .gitignore）。 */
const localPatternsFile = join(repoRoot, '.leak-patterns.local');
const localPatterns = existsSync(localPatternsFile)
    ? readFileSync(localPatternsFile, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
    : [];

function buildRules() {
    const rules = [];
    const add = (name, pattern) => {
        if (pattern) rules.push({ name, re: new RegExp(pattern) });
    };

    // 同一个绝对路径在源码里有三种写法：反斜杠、双反斜杠（JS / TS 字符串转义）、正斜杠。
    // 只匹配第一种会直接漏过——实测经历过一次“双反斜杠写法的家目录路径公开很久”的事故。
    // 路径类规则一律从这里生成。
    const SEP = '(?:\\\\{1,2}|/)+';
    const pathVariants = (p) => p
        .split(/[\\/]+/)
        .filter(Boolean)
        .map(esc)
        .join(SEP);

    if (process.env.USERNAME) add('当前用户名', esc(process.env.USERNAME));
    if (process.env.USERPROFILE) add('当前家目录', pathVariants(process.env.USERPROFILE));
    if (process.env.COMPUTERNAME) add('当前计算机名', esc(process.env.COMPUTERNAME));

    // 云盘 / 同步根的实际目录名（形如「<厂商> - <单位>」）比只列厂商词更精准：
    // 单位名正是最需要拦住的那部分。变量名与厂商词一律拆开拼接，避免扫描器自我命中。
    const SYNC_KEYS = ['One' + 'Drive', 'One' + 'DriveCommercial', 'One' + 'DriveConsumer', 'Drop' + 'box'];
    for (const key of SYNC_KEYS) {
        const value = process.env[key];
        if (!value) continue;
        const leaf = value.split(/[\\/]/).filter(Boolean).pop();
        if (leaf) add(`同步根目录名（${key}）`, esc(leaf));
    }

    add('家目录式绝对路径', '[A-Za-z]:' + SEP + 'Users' + SEP + '(?!me|<user>|<用户名>)[A-Za-z0-9_.\\-]+');
    add('回环地址带端口', '127\\.0\\.0\\.1:\\d+');
    add('内网 IP', '\\b(?:10|172\\.(?:1[6-9]|2\\d|3[01])|192\\.168)\\.\\d{1,3}\\.\\d{1,3}\\b');
    // 厂商词是公开常识、不指向具体机器，保留它可拦住“只写了厂商名而没写后缀”的情况。
    const VENDORS = ['One' + 'Drive', 'Drop' + 'box', '坚果' + '云', '百度' + '网盘'];
    add('云盘 / 中转仓库', VENDORS.join('|'));
    // 规模类计数：会暴露本机资产数量（技能 / 插件 / 仓库各有多少），属于机器事实。
    add('规模类计数', '\\d+\\s*个\\s*(?:技能|插件|仓库)');
    add('工作区根目录', pathVariants(workspaceRoot));

    // 凭据形态：命中即中止发布；只识别众所周知的 token 前缀与私钥块，避免误伤普通示例。
    add('私钥块', '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----');
    add('npm token', '\\bnpm_[A-Za-z0-9]{36}\\b');
    add('GitHub token', '\\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,})\\b');

    for (const pattern of localPatterns) add(`本机专属：${pattern}`, pattern);
    return rules;
}

const TARGETS = ['lib', 'tests', 'scripts', 'README.md', 'package.json', 'cordis.patch.yml', 'CHANGELOG.md'];

function collect(path) {
    if (!existsSync(path)) return [];
    if (statSync(path).isFile()) return [path];
    return readdirSync(path).flatMap((entry) => collect(join(path, entry)));
}

const rules = buildRules();
const files = TARGETS.map((target) => join(repoRoot, target)).flatMap(collect);

console.log(
    `[check-leaks] 扫描 ${files.length} 个文件 / ${rules.length} 条规则`
    + `（其中本机专属 ${localPatterns.length} 条）：`
    + TARGETS.filter((target) => existsSync(join(repoRoot, target))).join(', '),
);

/** 公开包元数据里的作者联系方式是发布者**有意公开**的信息（仓库与 npm 页面本就展示，
 *  邮箱不按本机指纹处置），所以扫描 package.json 前先去掉 author 字段。 */
function withoutPublicAuthorField(file, text) {
    if (!file.endsWith('package.json')) return text;
    return text
        .replace(/"author"\s*:\s*\{[\s\S]*?\}\s*,?/g, '')
        .replace(/"author"\s*:\s*"[^"]*"\s*,?/g, '');
}

let hits = 0;
for (const file of files) {
    const text = withoutPublicAuthorField(file, readFileSync(file, 'utf8'));
    for (const rule of rules) {
        const matches = text.match(new RegExp(rule.re.source, 'g'));
        if (!matches) continue;
        hits += 1;
        const line = text.slice(0, text.search(rule.re)).split('\n').length;
        const sample = [...new Set(matches)].slice(0, 3).join(' / ');
        console.error(`  ✗ ${relative(repoRoot, file)}:${line}  [${rule.name}]  ${matches.length} 处：${sample}`);
    }
}

if (hits > 0) {
    console.error(`\n[check-leaks] 发现 ${hits} 类本机指纹/凭据命中 —— 发布前必须清除。`);
    process.exit(1);
}
console.log('  ✓ 无本机指纹 / 凭据命中');
