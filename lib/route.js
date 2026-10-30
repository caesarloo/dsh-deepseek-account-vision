/**
 * 自动转译代理路由：为一个已注册的模型提供方包一层“识图路由”。
 *
 * 结构照 dsh-vision-proxy 的思路，但识图后端换成 DeepSeek 账号路由
 * （DeepSeek-V4.1-Flash），且转译调用走 `ctx.llm.stream()`（不是直连 HTTP）：
 *
 *   GUI 贴图 ──▶ <innerProvider>-vision 路由（声明支持图片输入，附件放行）
 *                    │  把消息里的每个 image 块交给 DeepSeek-V4.1-Flash 转译
 *                    ▼
 *             原模型（纯文本也能“看到”图片，因为它收到的是转译文本）
 *
 * 关键点：
 * - 只改 `inputModalities`，让附件预检与 `read_image` 门禁放行图片；
 * - 把图片换成文本后再委托给原提供方的适配器（原模型永远收不到图片字节）；
 * - 转译结果按图片内容哈希缓存，同一条历史里的旧图片不会每轮重复识图；
 * - 失败默认插入占位文本（failureMode=placeholder），坏端点不会毒化会话。
 *
 * @module dsh-deepseek-account-vision/route
 */
import { failurePlaceholder, toVisionError } from './errors.js';
import { sha256Hex } from './hash.js';
import { DEFAULT_TRANSCRIBE_PROMPT } from './config.js';

/** 图片块 → 转译文本块后使用的提示词。 */
const IMAGE_MARKER_SEPARATOR = '\n';

/**
 * 判断一段内容里是否含图片（含 tool-result 嵌套，兼容旧结构）。
 * @param {readonly object[]} content 内容块数组。
 * @returns {boolean}
 */
export function hasImageContent(content) {
    if (!Array.isArray(content)) return false;
    return content.some((block) => {
        if (block?.type === 'image') return true;
        if (block?.type === 'tool-result' && Array.isArray(block.content)) return hasImageContent(block.content);
        return false;
    });
}

/**
 * 判断整条消息列表里是否含图片。
 * @param {readonly object[]} messages 消息数组。
 * @returns {boolean}
 */
export function hasAnyImage(messages) {
    return Array.isArray(messages) && messages.some((message) => hasImageContent(message.content));
}

/**
 * 转译一个图片块；失败时按 failureMode 决定抛错还是插入占位文本。
 * @param {object} options 依赖与输入。
 * @returns {Promise<{type: 'text', text: string}>}
 */
async function transcribeImageBlock({ ctx, resolved, gateway, block, prompt, signal }) {
    const markerText = (text) => ({ type: 'text', text: `${resolved.marker}${IMAGE_MARKER_SEPARATOR}${text}` });

    if (block.offloaded === true) return markerText('[图片已卸载，无法识别]');

    const attachments = ctx.get('attachments');
    if (attachments === undefined) {
        throw new Error('dsh-deepseek-account-vision: 没有挂载附件服务，无法读取历史图片');
    }

    let stored;
    try {
        stored = await attachments.readImage(block.attachment, signal);
    } catch (error) {
        const visionError = toVisionError(error, 'ATTACHMENT_READ_FAILED');
        if (resolved.failureMode === 'error') throw visionError;
        return { type: 'text', text: failurePlaceholder(visionError) };
    }

    const ref = stored?.ref ?? block.attachment;
    const data = stored?.data;
    const key = data === undefined
        ? `route:ref:${String(block.attachment?.attachmentId ?? 'unknown')}`
        : `route:${sha256Hex(data)}:${sha256Hex(prompt)}:${resolved.visionProvider}/${resolved.visionModel}`;

    try {
        const result = await gateway.analyze({ key, ref, prompt, signal });
        return markerText(result.text);
    } catch (error) {
        const visionError = toVisionError(error);
        if (resolved.failureMode === 'error') throw visionError;
        return { type: 'text', text: failurePlaceholder(visionError) };
    }
}

/**
 * 递归替换一组内容块里的图片。
 * @returns {Promise<object[]>}
 */
async function transcribeBlocks({ ctx, resolved, gateway, prompt, blocks, signal }) {
    const out = [];
    for (const block of blocks) {
        if (block?.type === 'image') {
            out.push(await transcribeImageBlock({ ctx, resolved, gateway, block, prompt, signal }));
        } else if (block?.type === 'tool-result' && hasImageContent(block.content)) {
            out.push({ ...block, content: await transcribeBlocks({ ctx, resolved, gateway, prompt, blocks: block.content, signal }) });
        } else {
            out.push(block);
        }
    }
    return out;
}

/**
 * 把所有含图片的消息替换成纯文本版本；不含图片的消息原样通过。
 * @param {object} options 依赖与输入。
 * @returns {Promise<object[]>}
 */
export async function transcribeMessages({ ctx, resolved, gateway, messages, signal }) {
    if (!hasAnyImage(messages)) return messages;
    const prompt = resolved.transcribePrompt !== '' ? resolved.transcribePrompt : DEFAULT_TRANSCRIBE_PROMPT;
    const out = [];
    for (const message of messages) {
        if (!hasImageContent(message.content)) {
            out.push(message);
            continue;
        }
        out.push({
            ...message,
            content: await transcribeBlocks({ ctx, resolved, gateway, prompt, blocks: message.content, signal }),
        });
    }
    return out;
}

/**
 * 为一个 provider 构造识图代理适配器。
 * @param {object} options 依赖。
 * @param {object} options.ctx 插件上下文（需要 `llm` 服务）。
 * @param {object} options.resolved 归一化配置。
 * @param {object} options.gateway 识图网关。
 * @param {string} options.innerProvider 被包裹的 provider 路由 id。
 * @param {string} options.innerName 被包裹路由的显示名。
 * @returns {object} 代理适配器。
 */
export function createVisionAdapter({ ctx, resolved, gateway, innerProvider, innerName }) {
    // 委托链只走 ctx.llm 的公开面：runtime 在 0.2.x 把 registration() 声明为
    // private（dsh-llm 的 `LlmRuntime.registration`），靠它拿 inner adapter 会在
    // 宿主收紧内部实现时静默失效（所有 -vision 路由注册不出去）。公开面里
    // providerRetryPolicy / imageRequestPricing / imageRequestTarget / listModels /
    // resolveModelInfo / stream 都按 provider 路由解析，语义与 inner adapter 等价。
    const routeName = resolved.routeNameTemplate
        .split('{name}').join(innerName)
        .split('{provider}').join(innerProvider);

    const adapter = {
        providerInfo(provider) {
            return { id: provider, name: routeName };
        },
        providerRetryPolicy() {
            return ctx.llm.providerRetryPolicy(innerProvider);
        },
        imageRequestPricing(_provider, model) {
            return ctx.llm.imageRequestPricing(innerProvider, model);
        },
        imageRequestTarget(_provider, model, image) {
            return ctx.llm.imageRequestTarget(innerProvider, model, image);
        },
        async listModels(provider) {
            try {
                const models = await ctx.llm.listModels(innerProvider);
                return models.map((model) => ({ ...model, provider }));
            } catch (error) {
                ctx.logger.warn(`dsh-deepseek-account-vision: 路由 "${provider}" 列模型失败（inner=${innerProvider}）: ${error instanceof Error ? error.message : String(error)}`);
                return [];
            }
        },
        async resolveModel(provider, model, signal) {
            const info = await ctx.llm.resolveModelInfo(innerProvider, model, signal);
            // 关键：对外声明支持图片，附件预检与 read_image 门禁才会放行。
            return { ...info, provider, inputModalities: ['text', 'image'] };
        },
        async prepareCall(provider, model, signal) {
            // 不再借用 inner 的 prepareCall（属 adapter 私有面）：公开的
            // resolveModelInfo 已足够给出 exact model 元数据，真正的 inner 路由
            // 解析由本适配器 stream 里的 ctx.llm.stream 完成。
            return {
                model: await adapter.resolveModel(provider, model, signal),
                stream: (options) => adapter.stream(options),
            };
        },
        async *stream(options) {
            const messages = await transcribeMessages({
                ctx,
                resolved,
                gateway,
                messages: options.messages,
                signal: options.signal,
            });
            yield* ctx.llm.stream({ ...options, provider: innerProvider, messages });
        },
    };
    return adapter;
}
