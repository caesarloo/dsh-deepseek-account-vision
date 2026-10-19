/**
 * `deepseek_vision` 工具：主模型是任意模型时，都能借 DeepSeek 账号的
 * DeepSeek-V4.1-Flash 识别一张图片（本地路径或 http(s) URL），拿回文字结果。
 *
 * 这里直接给出 registry 需要的纯对象定义（不依赖 `@deepseek-ai/dsh-tools`
 * 的 `defineTool` 包装）：参数用标准 JSON Schema 声明，入参由本模块自己校验。
 * 这样插件运行时只依赖 `schemastery`，离线可测，也不受宿主依赖解析差异影响。
 *
 * @module dsh-deepseek-vision/tool
 */
import { DEFAULT_RECOGNITION_PROMPT } from './config.js';
import {
    imageLimitsOf,
    readImageFromPath,
    readImageFromUrl,
    saveImageAttachment,
} from './image-source.js';
import { sha256Hex } from './hash.js';

const TOOL_DESCRIPTION = [
    '用 DeepSeek 账号的 DeepSeek-V4.1-Flash（deepseek-flash，1017 版）识别一张图片并返回文字结果。',
    '主模型是纯文本模型、或不想把图片放进主模型上下文时使用。',
    '参数二选一：image_path（本地图片路径，PNG/JPEG/WebP/GIF，相对路径按会话工作目录解析）或 image_url（http(s) 图片地址）；',
    '可选 prompt 指定识别重点（例如“只识别截图里的文字”）。',
    '返回完整文字转译：逐字 OCR、版面结构、主要视觉元素与关键细节。',
].join('');

/**
 * 构造工具定义。
 * @param {object} options 依赖。
 * @param {object} options.ctx 工具注册作用域的上下文（需要 `fs`、`workingDirectory`、`attachments`）。
 * @param {object} options.resolved 归一化配置。
 * @param {ReturnType<import('./vision.js').createVisionGateway>} options.gateway 识图网关。
 * @returns {object} registry-ready 工具定义。
 */
export function createVisionTool({ ctx, resolved, gateway }) {
    const attachments = ctx.get('attachments');
    const limits = imageLimitsOf(attachments);
    const defaultPrompt = resolved.recognitionPrompt !== '' ? resolved.recognitionPrompt : DEFAULT_RECOGNITION_PROMPT;

    return {
        name: resolved.toolName,
        description: TOOL_DESCRIPTION,
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                image_path: {
                    type: 'string',
                    description: '本地图片路径（PNG/JPEG/WebP/GIF）；相对路径按会话工作目录解析。与 image_url 二选一。',
                },
                image_url: {
                    type: 'string',
                    description: 'http(s) 图片地址。与 image_path 二选一。',
                },
                prompt: {
                    type: 'string',
                    description: '可选：希望识图模型重点识别的内容；留空则做完整转译。',
                },
            },
        },
        timeoutMs: resolved.timeoutMs + 30_000,
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                required: ['text', 'model', 'source', 'truncated'],
                properties: {
                    text: { type: 'string', description: '识图结果（完整文字转译）。' },
                    model: { type: 'string', description: '实际使用的识图模型 id。' },
                    source: { type: 'string', description: '图片来源（规范化路径或 URL）。' },
                    truncated: { type: 'boolean', description: '识图模型是否因输出上限被截断。' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.text }],
            presentationMeta: (args) => ({
                path: typeof args.image_path === 'string' && args.image_path.trim() !== ''
                    ? args.image_path
                    : typeof args.image_url === 'string' ? args.image_url : '',
            }),
        },
        isConcurrencySafe: () => true,
        presentCall(args) {
            const path = typeof args?.image_path === 'string' ? args.image_path : undefined;
            const url = typeof args?.image_url === 'string' ? args.image_url : undefined;
            return {
                card: 'generic',
                title: `识别图片 ${path ?? url ?? ''}`,
                kind: 'read',
                ...(path === undefined ? {} : { locations: [{ path }] }),
            };
        },
        async execute(args, exec) {
            const imagePath = typeof args?.image_path === 'string' ? args.image_path.trim() : '';
            const imageUrl = typeof args?.image_url === 'string' ? args.image_url.trim() : '';
            if (imagePath === '' && imageUrl === '') throw new Error('必须提供 image_path 或 image_url 之一');
            if (imagePath !== '' && imageUrl !== '') throw new Error('image_path 与 image_url 只能提供一个');
            if (attachments === undefined) throw new Error('没有挂载附件服务，无法保存图片并识图');

            const customPrompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
            // 自定义 prompt 原样尊重（主模型要什么就识别什么）；留空才用内置的完整转译提示词。
            const prompt = customPrompt === '' ? defaultPrompt : customPrompt;

            const image = imagePath !== ''
                ? await readImageFromPath(ctx, exec, imagePath, limits)
                : await readImageFromUrl(imageUrl, {
                    maxBytes: limits.byteCap,
                    timeoutMs: resolved.urlTimeoutMs,
                    signal: exec.signal,
                });

            const key = `tool:${sha256Hex(image.data)}:${sha256Hex(prompt)}:${resolved.visionProvider}/${resolved.visionModel}`;
            const cached = gateway.cache.get(key);
            if (cached !== undefined) {
                const value = /** @type {{text: string, model: string, truncated?: boolean}} */ (cached);
                return {
                    text: value.text,
                    model: value.model,
                    source: image.source,
                    truncated: value.truncated === true,
                };
            }

            const ref = await saveImageAttachment(attachments, {
                data: image.data,
                mediaType: image.mediaType,
                name: image.name,
            });
            const result = await gateway.analyze({
                key,
                ref,
                prompt,
                signal: exec.signal,
            });
            return {
                text: result.text,
                model: result.model,
                source: image.source,
                truncated: result.truncated === true,
            };
        },
    };
}
