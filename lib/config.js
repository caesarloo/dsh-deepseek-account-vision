/**
 * dsh-deepseek-vision：配置、默认提示词与配置归一化。
 *
 * 本插件不自带任何 API Key：识图请求全部经 `ctx.llm` 的 DeepSeek 账号路由
 * （默认 `deepseek-account` / `deepseek-flash`）发出，复用 DSH 里已登录的
 * DeepSeek 账号凭据。这既是本插件与“直连第三方 VLM”的 dsh-vision-proxy 的
 * 核心区别，也意味着用户不需要再配置 key。
 *
 * @module dsh-deepseek-vision/config
 */
import z from 'schemastery';

/** 默认识图后端：DeepSeek 账号路由。 */
export const DEFAULT_VISION_PROVIDER = 'deepseek-account';
/** 默认识图模型：目录名 DeepSeek-V4.1-Flash（1017），同时支持文本与图片输入。 */
export const DEFAULT_VISION_MODEL = 'deepseek-flash';
/** 自动转译文本的默认前缀标记。 */
export const DEFAULT_MARKER = '[图片转译]';
/** 默认注册的工具名（模型可见，snake_case）。 */
export const DEFAULT_TOOL_NAME = 'deepseek_vision';
/** 识图路由默认后缀：`<innerProvider>-vision`。 */
export const DEFAULT_ROUTE_SUFFIX = '-vision';
/** 识图路由默认显示名模板。 */
export const DEFAULT_ROUTE_NAME = '{name} + DeepSeek 识图';

/** 工具默认提示词：面向“主模型看不到图，需要完整转译”的场景。 */
export const DEFAULT_RECOGNITION_PROMPT = `你正在直接观察用户给出的这张图片，你的输出会交给另一位看不到图片的模型阅读。请输出一份忠实、完整、结构化的文字结果：
1. 一句话总览：这张图是什么（截图 / 照片 / 图表 / 海报 / 表情包 / 文档 / 界面等）以及主题。
2. 全部可见文字：逐字转录，保留原语言、顺序与层级；表格按行列输出；不要概括、不要漏字。
3. 版面与视觉结构：区域划分、主要对象、人物或动物、颜色、图标、界面控件、图表及其数据。
4. 关键细节：数字、时间、地址、URL、代码、报错信息、按钮文案等。
要求：只描述图片本身，不要寒暄；不要输出“如果看不到图”“可以想象成”之类的假设性描述；看不清的地方标注“（不清晰）”；不要臆造不存在的内容。`;

/** 自动转译路由默认提示词：结果会替换原图片块进入主模型上下文。 */
export const DEFAULT_TRANSCRIBE_PROMPT = `你正在直接观察用户给出的这张图片，你的转译会交给另一位看不到图片、需要据此回答用户的纯文本模型。
请输出：
1. 图片类型与一句话总览；
2. 全部可见文字逐字转录（保留原语言与结构；表格按行列输出）；
3. 版面、结构、主要对象、颜色、图标、界面元素等关键视觉信息；
4. 数字、时间、URL、代码等关键细节。
要求：忠实、完整；不寒暄、不臆造；不要输出“如果看不到图”“可以想象成”之类的假设性描述；看不清处标注“（不清晰）”。输出语言与图中主要文字一致；图中没有文字时用中文。`;

/** 自定义工具提示词时的补充指令（保证转译对“看不到图”的接收方足够完整）。 */
export const CUSTOM_PROMPT_SUFFIX = `请优先回答上面的问题；同时给出必要的文字转录与上下文，确保看不到图片的模型也能理解。`;

/**
 * 插件配置 schema。bundle patch 只写部分键时，未列出的键回落到这里的默认值。
 */
export const Config = z.object({
    visionProvider: z.string().default(DEFAULT_VISION_PROVIDER)
        .description('识图后端使用的已注册 provider 路由；默认 DeepSeek 账号路由'),
    visionModel: z.string().default(DEFAULT_VISION_MODEL)
        .description('识图模型 id；默认 deepseek-flash（DeepSeek-V4.1-Flash / 1017，原生多模态）'),
    visionMaxTokens: z.number().step(1).min(1).max(32_768).default(4096)
        .description('识图模型的输出上限；思考型模型请留足预算'),
    timeoutMs: z.number().step(1).min(1_000).max(300_000).default(120_000)
        .description('单张图片识图请求的超时时间'),
    tool: z.boolean().default(true)
        .description('是否注册 deepseek_vision 工具（主模型是任意模型时都可调用）'),
    toolName: z.string().default(DEFAULT_TOOL_NAME)
        .description('注册的工具名（模型可见，建议 snake_case）'),
    autoTranscribe: z.boolean().default(true)
        .description('是否为模型提供方注册自动转译路由，把 GUI 附带的图片转成文字'),
    wrapAllProviders: z.boolean().default(true)
        .description('true = 自动包裹所有已注册 provider（含之后动态注册的）；false = 只包裹 innerProviders'),
    innerProviders: z.array(z.string()).default([])
        .description('wrapAllProviders=false 时要包裹的 provider 路由 id 列表'),
    routeSuffix: z.string().default(DEFAULT_ROUTE_SUFFIX)
        .description('识图路由 id 后缀，最终 id 为 <innerProvider><routeSuffix>'),
    routeNameTemplate: z.string().default(DEFAULT_ROUTE_NAME)
        .description('识图路由显示名模板；{name} 会被替换成被包裹路由的名称'),
    marker: z.string().default(DEFAULT_MARKER)
        .description('自动转译文本的前缀标记'),
    failureMode: z.union(['placeholder', 'error']).default('placeholder')
        .description('自动转译失败时的行为：placeholder 插入失败占位文本并继续对话（默认），error 让整轮失败'),
    transcribePrompt: z.string().default('')
        .description('覆盖自动转译提示词；留空使用内置提示词'),
    recognitionPrompt: z.string().default('')
        .description('覆盖工具识图提示词；留空使用内置提示词'),
    cacheSize: z.number().step(1).min(0).max(5_000).default(200)
        .description('进程内识图结果缓存条数（按图片内容 SHA-256 去重；0 关闭）'),
    urlTimeoutMs: z.number().step(1).min(1_000).max(120_000).default(30_000)
        .description('deepseek_vision 拉取 http(s) 图片的超时时间'),
});

function requireNonEmptyString(key, value) {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`dsh-deepseek-vision: config.${key} must be a non-empty string`);
    return value.trim();
}

function requirePositiveInteger(key, value, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`dsh-deepseek-vision: config.${key} must be an integer between ${min} and ${max}`);
    return value;
}

/**
 * 把 loader 解析后的配置（或测试/手工传入的部分配置）归一化为冻结对象。
 * bundle patch 里只写少数字段时也能安全补全默认值。
 * @param {Record<string, unknown>} [input] 原始配置。
 * @returns {Readonly<Record<string, unknown>>} 归一化后的配置。
 */
export function resolveConfig(input = {}) {
    const raw = input === null || typeof input !== 'object' ? {} : input;
    const pick = (key, fallback) => (raw[key] === undefined || raw[key] === null ? fallback : raw[key]);

    const failureMode = pick('failureMode', 'placeholder');
    if (failureMode !== 'placeholder' && failureMode !== 'error') {
        throw new Error('dsh-deepseek-vision: config.failureMode must be "placeholder" or "error"');
    }
    const innerProviders = pick('innerProviders', []);
    if (!Array.isArray(innerProviders) || innerProviders.some((id) => typeof id !== 'string' || id.trim() === '')) {
        throw new Error('dsh-deepseek-vision: config.innerProviders must be an array of non-empty provider ids');
    }
    const wrapAllProviders = pick('wrapAllProviders', true);
    if (typeof wrapAllProviders !== 'boolean') throw new Error('dsh-deepseek-vision: config.wrapAllProviders must be a boolean');
    const tool = pick('tool', true);
    if (typeof tool !== 'boolean') throw new Error('dsh-deepseek-vision: config.tool must be a boolean');
    const autoTranscribe = pick('autoTranscribe', true);
    if (typeof autoTranscribe !== 'boolean') throw new Error('dsh-deepseek-vision: config.autoTranscribe must be a boolean');

    return Object.freeze({
        visionProvider: requireNonEmptyString('visionProvider', pick('visionProvider', DEFAULT_VISION_PROVIDER)),
        visionModel: requireNonEmptyString('visionModel', pick('visionModel', DEFAULT_VISION_MODEL)),
        visionMaxTokens: requirePositiveInteger('visionMaxTokens', pick('visionMaxTokens', 4096), { max: 32_768 }),
        timeoutMs: requirePositiveInteger('timeoutMs', pick('timeoutMs', 120_000), { min: 1_000, max: 300_000 }),
        tool,
        toolName: requireNonEmptyString('toolName', pick('toolName', DEFAULT_TOOL_NAME)),
        autoTranscribe,
        wrapAllProviders,
        innerProviders: Object.freeze(innerProviders.map((id) => id.trim())),
        routeSuffix: requireNonEmptyString('routeSuffix', pick('routeSuffix', DEFAULT_ROUTE_SUFFIX)),
        routeNameTemplate: requireNonEmptyString('routeNameTemplate', pick('routeNameTemplate', DEFAULT_ROUTE_NAME)),
        marker: typeof pick('marker', DEFAULT_MARKER) === 'string' ? pick('marker', DEFAULT_MARKER) : DEFAULT_MARKER,
        failureMode,
        transcribePrompt: typeof pick('transcribePrompt', '') === 'string' ? pick('transcribePrompt', '').trim() : '',
        recognitionPrompt: typeof pick('recognitionPrompt', '') === 'string' ? pick('recognitionPrompt', '').trim() : '',
        cacheSize: requirePositiveInteger('cacheSize', pick('cacheSize', 200), { min: 0, max: 5_000 }),
        urlTimeoutMs: requirePositiveInteger('urlTimeoutMs', pick('urlTimeoutMs', 30_000), { min: 1_000, max: 120_000 }),
    });
}
