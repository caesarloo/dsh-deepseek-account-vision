# Changelog

本项目的所有重要改动都记录在这里。版本号遵循语义化版本（主.次.修）。

## [0.1.2] - 2026-10-30

**自动转译路由改用宿主公开接口；DSH 0.2.1-rc.5 复验**

- `lib/route.js` 的委托链不再读 `ctx.llm.registration(...)`（宿主 `LlmRuntime` 把它声明为
  `private` 的运行时句柄）。改为 `ctx.llm` 的公开 API：`providerRetryPolicy` /
  `imageRequestPricing` / `imageRequestTarget` / `listModels` / `resolveModelInfo` / `stream`。
  行为等价；变化在于宿主收紧内部实现时，不会再把所有 `<provider>-vision` 路由静默注册失败
  （旧实现下失败只留一条 warn，用户看到的是"贴图后没有转译"）。
- `prepareCall` 不再借用 inner adapter 的 `prepareCall`（同属 adapter 私有面）：改为公开的
  `resolveModelInfo` + 本适配器 `stream` 内用 `ctx.llm.stream({ provider: innerProvider, ... })`
  委托，代价是每次委托多一次 inner 路由解析。
- 测试同步：`tests/fake-context.js` 不再 mock 私有 `registration`，改为 mock 上述公开方法；
  29 个单测全绿。
- 在 DSH **0.2.1-rc.5** 桌面端复验（2026-10-30）：`deepseek_vision` 工具与 `-vision` 路由正常；
  0.2.1-rc.3 → rc.5 之间插件契约面逐字节零变化。

## [0.1.1] - 2026-10-24

**DSH 0.2.1-rc.3 复验与版本范围收口**

- 在 DSH 0.2.1-rc.3 桌面端复验：`deepseek_vision` 真实识图正常，**无代码改动**。
- `engines.dsh` 由 `>=0.2.1-rc.2` 收紧为 `>=0.2.1-rc.2 <0.3.0`：上界是刻意的，DSH 0.3 会被
  有意拒绝，直到本插件重新复验并发新版；确需在范围外宿主先跑，用插件管理器的精确版本豁免
  （`profiles/<profile>/compatibility.json`），不要改版本范围。
- README 中英文的依赖/兼容说明同步更新（含上界与豁免说明）。
- 发布闸门修正：`scripts/check-leaks.mjs` 不再把 `package.json` 的 `author` 字段当本机指纹
  （作者邮箱属**有意公开**的包元数据；原先会因邮箱前缀与系统用户名相同而误报，导致
  `prepublishOnly` 无法通过）。

本版无运行时功能变更。

## [0.1.0] - 2026-10-19

首个版本。npm 包名为 `@caesarloo/dsh-deepseek-account-vision`
（无 scope 的同义名已被他人占用，故加 scope 并保留 account 语义）。

### 新增

- **`deepseek_vision` 工具**：主模型是任意模型时，都能用 DeepSeek 账号的
  DeepSeek-V4.1-Flash（`deepseek-flash`，1017 版）识别图片——支持本地
  PNG/JPEG/WebP/GIF 路径与 `http(s)` 图片 URL，可选 `prompt` 指定识别重点。
- **自动转译路由**：为每个已注册 provider 包一层 `<provider>-vision` 路由
  （默认显示名 `<provider 名称> + 自动识图`），在 GUI 里给纯文本主模型贴图时，
  图片先由 DeepSeek-V4.1-Flash 转成文字，再交给原模型作答。
  - `wrapAllProviders`（默认开）覆盖已注册与之后动态注册的 provider；
    `innerProviders` 可改为只包裹指定 provider。
  - `failureMode: placeholder`（默认）在转译失败时插入 `[图片转译失败: …]`
    并继续对话；`error` 则让整轮失败。
- **零密钥**：识图请求统一走 `ctx.llm.stream()` 的 DeepSeek 账号路由
  （默认 `deepseek-account`），复用 DSH 的 DeepSeek 登录态，插件不保存凭据。
- **稳定与省费**：按图片内容 SHA-256 的进程内缓存、同键并发合并、
  失败图片 60 秒冷却、请求超时快速失败。
- **发布闸门**：`prepublishOnly` 先跑离线单测 + UTF-8 BOM 检查 + 本机指纹/凭据扫描
  （`scripts/check-leaks.mjs`，规则自足、含路径写法变体；`.leak-patterns.local` 不进库）
  + bundle 清单一致性检查（入口 / patch 随包 / insert name / engines.dsh）；
  中英双语 README 通过结构与指纹审核。
