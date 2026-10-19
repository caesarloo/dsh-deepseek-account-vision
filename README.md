# @caesarloo/dsh-deepseek-account-vision

[English](#english) | [中文](#中文)

---

## English

Give **any** main model in DeepSeek Harness the vision of the DeepSeek account: recognize images with **DeepSeek-V4.1-Flash** (`deepseek-flash`, release 1017) — through a `deepseek_vision` tool, or automatically for images attached to a text-only chat model. No API key, no extra VLM account, no image library.

### What it does

- Adds a model-facing tool `deepseek_vision`: pass a local PNG/JPEG/WebP/GIF path or an `http(s)` image URL, get back a complete textual rendition (verbatim OCR, layout, visual elements, key details).
- Answers with the **DeepSeek account route** (`deepseek-account` / `deepseek-flash` by default), so it reuses the DeepSeek login you already have in DSH — the plugin never stores credentials.
- Registers automatic image-transcription routes: for every registered provider it adds a `<provider>-vision` route that declares image input, turns each attached image into text with DeepSeek-V4.1-Flash, then delegates the conversation to the original model. A pure-text main model can finally "see" a pasted screenshot.
- Caches results by image content hash (in-process only), merges concurrent identical requests, cools down a failed image for 60 s, and fails fast instead of hanging.
- Works alongside everything: text-only conversations pass through untouched; the original model, tools and history shape stay the same.

### Install

```sh
dsh plugin --profile <profile> add @caesarloo/dsh-deepseek-account-vision
```

From a local checkout, install by directory instead: `dsh plugin --profile <profile> add <project-directory>`.

Restart DSH once (bundle layers have no hot reload), then verify that `deepseek_vision` appears in the tool list of a new session. A patch-layer development install (`- insert:` with the plugin entry file) reloads hot without a restart.

Requirements: DSH `>= 0.2.1-rc.2`, a signed-in DeepSeek account, and the standard `llm` / `attachments` / `fs` services (all present in the shipped bundle).

### Usage

**1. Tool — any main model can call it**

```json
{
  "image_path": "screenshot.png",
  "prompt": "Transcribe every visible character and describe the layout"
}
```

or, for a remote image:

```json
{ "image_url": "https://example.com/chart.png" }
```

The tool returns `{ text, model, source, truncated }`. The image never enters the main model's context — only the transcription does. A custom `prompt` is passed to the vision model verbatim; leave it out to use the built-in full-transcription prompt.

**2. Automatic transcription route — paste images into a text-only chat**

Pick the route named **`<provider> + 自动识图`** (id `<provider>-vision`, configurable) in the model selector, then attach an image as usual. The image block is transcribed before the original adapter sees the request:

```
GUI image ──▶ <provider>-vision route (declares image input → attachment admitted)
                  │  each image block is transcribed by DeepSeek-V4.1-Flash
                  ▼
            original model (receives plain text, answers normally)
```

Transcribed text is prefixed with `[图片转译]`. When transcription fails and `failureMode` is `placeholder` (default), an explicit `[图片转译失败: …]` marker is inserted and the conversation continues.

| Situation | What to use |
|---|---|
| Any model, image exists as a file or URL | `deepseek_vision` tool |
| Text-only model, image attached in the GUI | the `<provider>-vision` route |
| Main model already accepts images | no plugin needed for that turn |

### Configuration

Defaults ship in `cordis.patch.yml`; override them in your profile's `cordis.patch.yml` with an `- id: dsh-deepseek-vision` entry. Unlisted keys fall back to the defaults below.

| Key | Default | Meaning |
|---|---|---|
| `visionProvider` | `deepseek-account` | Registered provider route used for image recognition |
| `visionModel` | `deepseek-flash` | Vision model id (DeepSeek-V4.1-Flash / 1017) |
| `visionMaxTokens` | `4096` | Output cap for the vision model |
| `timeoutMs` | `120000` | Per-image recognition timeout |
| `tool` | `true` | Register the `deepseek_vision` tool |
| `toolName` | `deepseek_vision` | Tool name exposed to models |
| `autoTranscribe` | `true` | Register automatic image-transcription routes |
| `wrapAllProviders` | `true` | Wrap every registered provider (including ones registered later) |
| `innerProviders` | `[]` | Providers to wrap when `wrapAllProviders=false` |
| `routeSuffix` | `-vision` | Route id suffix: `<provider><routeSuffix>` |
| `routeNameTemplate` | `{name} + 自动识图` | Route display name; `{name}` / `{provider}` are substituted |
| `marker` | `[图片转译]` | Prefix added to each transcription |
| `failureMode` | `placeholder` | `placeholder` keeps the turn alive; `error` fails the whole turn |
| `transcribePrompt` | `''` | Override the automatic-transcription prompt (empty = built-in) |
| `recognitionPrompt` | `''` | Override the `deepseek_vision` prompt (empty = built-in) |
| `cacheSize` | `200` | In-process result cache entries (0 disables) |
| `urlTimeoutMs` | `30000` | Timeout for downloading an `http(s)` image |

### Dependencies

- **No API key, no separate VLM account.** Recognition goes through `ctx.llm.stream()` on the DeepSeek account route; DSH's account service owns the credentials.
- **No image library.** Attachment normalization (size, pixels, format validation) is done by DSH's attachment service; the plugin only ships `schemastery` for config.
- **Node built-ins only** beyond that (`crypto`, `path`, global `fetch` / `AbortSignal`).

### Boundaries

- It does **not** turn the main model into a multimodal model: the original model still receives only text. It **does** make image input usable for it via transcription.
- It does **not** replace `read_image`: `read_image` hands the native image block to an image-capable model; `deepseek_vision` returns text so any model can consume it.
- It only accepts **PNG / JPEG / WebP / GIF** — no PDF, audio or video.
- Transcription is a lossy summary for dense screenshots: very small text or fine UI details may be missed. Use a stronger `visionModel` or a more explicit `prompt` when exactness matters.
- Images are sent to DeepSeek with the recognition request (that is the point) and are not otherwise persisted by the plugin; the result cache lives in process memory only.

### Development

```sh
pnpm install
npm test                 # unit tests + BOM + fingerprint/credential + bundle-manifest checks
npm run check-leaks      # fingerprint scan only
```

`prepublishOnly` runs `npm test`, so a package with a failing test, a BOM-prefixed source file, or a machine-specific fingerprint cannot be published. Publish explicitly against the official registry:

```sh
npm publish --registry https://registry.npmjs.org/
```

### License

MIT

---

## 中文

让 DeepSeek Harness 里的**任意主模型**都用上 DeepSeek 账号的视觉能力：用 **DeepSeek-V4.1-Flash**（`deepseek-flash`，1017 版）识别图片——既可以由模型调用 `deepseek_vision` 工具，也可以给纯文本主模型自动转译 GUI 里贴的图片。不需要 API Key，不需要另找视觉模型账号，不装图像库。

### 它做什么

- 注册模型可见的工具 `deepseek_vision`：给一个本地 PNG/JPEG/WebP/GIF 路径或 `http(s)` 图片地址，返回完整文字转译（逐字 OCR、版面结构、视觉元素、关键细节）。
- 识图后端走 **DeepSeek 账号路由**（默认 `deepseek-account` / `deepseek-flash`），复用 DSH 里已登录的 DeepSeek 账号，插件自身不保存任何凭据。
- 注册自动转译路由：为每个已注册 provider 加一条 `<provider>-vision` 路由，对外声明支持图片输入，收到图片后先用 DeepSeek-V4.1-Flash 转成文字，再交给原模型作答。纯文本主模型也能“看到”粘贴的截图。
- 按图片内容哈希缓存（仅进程内）、合并并发的同图请求、失败图片冷却 60 秒、超时快速失败而不是卡死。
- 与现有能力并存：纯文本对话零改动直达原模型，原模型、工具与会话历史结构都不变。

### 安装

```sh
dsh plugin --profile <profile> add @caesarloo/dsh-deepseek-account-vision
```

本地检出目录安装：`dsh plugin --profile <profile> add <项目目录>`。

安装后重启一次 DSH（bundle 层不支持热重载），再在新会话的工具列表里确认出现 `deepseek_vision`。开发期也可以用 patch 层 `- insert:` 指向插件入口文件装载，改完热生效、无需重启。

依赖：DSH `>= 0.2.1-rc.2`、已登录的 DeepSeek 账号，以及标准的 `llm` / `attachments` / `fs` 服务（随官方 bundle 提供）。

### 使用

**1. 工具——任意主模型都能调**

```json
{
  "image_path": "screenshot.png",
  "prompt": "逐字识别所有可见文字，并说明版式"
}
```

远程图片：

```json
{ "image_url": "https://example.com/chart.png" }
```

返回 `{ text, model, source, truncated }`。图片本身不会进入主模型上下文，只有转译文字会。自定义 `prompt` 会原样交给识图模型；留空才使用内置的完整转译提示词。

**2. 自动转译路由——给纯文本模型直接贴图**

在模型选择器里选 **`<provider> + 自动识图`**（id 为 `<provider>-vision`，可配置），然后照常附加图片。图片块会在原适配器收到请求之前被转译：

```
GUI 图片 ──▶ <provider>-vision 路由（声明支持图片 → 附件放行）
                  │  每个 image 块交给 DeepSeek-V4.1-Flash 转译
                  ▼
            原模型（收到纯文本，正常作答）
```

转译文本带 `[图片转译]` 前缀。转译失败且 `failureMode` 为默认的 `placeholder` 时，会插入 `[图片转译失败: …]` 占位文本并继续对话。

| 场景 | 用什么 |
|---|---|
| 任意模型，图片是文件或 URL | `deepseek_vision` 工具 |
| 纯文本模型，在 GUI 里贴图 | `<provider>-vision` 路由 |
| 主模型本来就支持图片 | 该轮不需要本插件 |

### 配置

默认值随 `cordis.patch.yml` 提供；在 profile 的 `cordis.patch.yml` 里用 `- id: dsh-deepseek-vision` 条目覆盖。未列出的键回落到下表默认值。

| 键 | 缺省 | 含义 |
|---|---|---|
| `visionProvider` | `deepseek-account` | 识图使用的已注册 provider 路由 |
| `visionModel` | `deepseek-flash` | 识图模型 id（DeepSeek-V4.1-Flash / 1017） |
| `visionMaxTokens` | `4096` | 识图模型输出上限 |
| `timeoutMs` | `120000` | 单张图片识图超时 |
| `tool` | `true` | 是否注册 `deepseek_vision` 工具 |
| `toolName` | `deepseek_vision` | 暴露给模型的工具名 |
| `autoTranscribe` | `true` | 是否注册自动转译路由 |
| `wrapAllProviders` | `true` | 包裹全部已注册 provider（含之后动态注册的） |
| `innerProviders` | `[]` | `wrapAllProviders=false` 时要包裹的 provider |
| `routeSuffix` | `-vision` | 路由 id 后缀：`<provider><routeSuffix>` |
| `routeNameTemplate` | `{name} + 自动识图` | 路由显示名；`{name}` / `{provider}` 会被替换 |
| `marker` | `[图片转译]` | 每条转译文本的前缀 |
| `failureMode` | `placeholder` | `placeholder` 保住本轮对话；`error` 让整轮失败 |
| `transcribePrompt` | `''` | 覆盖自动转译提示词（留空用内置） |
| `recognitionPrompt` | `''` | 覆盖 `deepseek_vision` 提示词（留空用内置） |
| `cacheSize` | `200` | 进程内结果缓存条数（0 关闭） |
| `urlTimeoutMs` | `30000` | 下载 `http(s)` 图片的超时 |

### 依赖约定

- **无 API Key、无独立视觉账号**：识图经 `ctx.llm.stream()` 打在 DeepSeek 账号路由上，凭据由 DSH 账号服务持有。
- **无图像库**：尺寸/像素/格式归一化由 DSH 附件服务完成；插件自身只依赖 `schemastery` 做配置校验。
- 其余只用 Node 内建能力（`crypto`、`path`、全局 `fetch` / `AbortSignal`）。

### 边界（明确不做）

- **不把主模型变成多模态模型**：原模型收到的仍然只有文字；本插件做的是“把图片转成文字再交给它”。
- **不替代 `read_image`**：`read_image` 把原生图片块交给支持图片的模型；`deepseek_vision` 返回文字，所以任何模型都能消费。
- 只接受 **PNG / JPEG / WebP / GIF**，不支持 PDF、音频、视频。
- 转译对密集截图是有损摘要：极小的字或精细 UI 细节可能丢失；要求精确时换更强的 `visionModel` 或把 `prompt` 写具体。
- 图片只随识图请求发送到 DeepSeek（这正是功能本身），插件不另行持久化；结果缓存只在进程内存中。

### 开发与发布

```sh
pnpm install
npm test                 # 单测 + BOM + 本机指纹/凭据 + bundle 清单一致性检查
npm run check-leaks      # 只跑指纹扫描
```

`prepublishOnly` 跑 `npm test`：单测失败、源码带 BOM、或命中本机指纹/凭据时都发不出去。发布时显式指定官方 registry：

```sh
npm publish --registry https://registry.npmjs.org/
```

### License

MIT
