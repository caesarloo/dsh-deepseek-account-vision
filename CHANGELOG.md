# Changelog

本项目的所有重要改动都记录在这里。版本号遵循语义化版本（主.次.修）。

## 0.1.0 — 2026-10-19

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
