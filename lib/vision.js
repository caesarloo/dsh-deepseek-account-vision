/**
 * 识图核心：通过 `ctx.llm.stream()` 调 DeepSeek 账号路由的
 * DeepSeek-V4.1-Flash（`deepseek-flash`）完成一次纯识图请求。
 *
 * 为什么绕 `ctx.llm` 而不是直连 HTTP：
 * - DeepSeek 账号路由的鉴权由 DSH 的账号服务负责（`x-dsh-auth-token`），
 *   插件不持有、也不该持有账号 token；
 * - `ctx.llm` 负责把长驻图片附件投影成该路由的请求格式，并统一错误分类；
 * - 账号登录态变化、模型目录刷新都自动生效，插件零配置、零密钥。
 *
 * 本模块不写盘、不打印密钥；失败只抛 `VisionError`（稳定 code + 中文提示）。
 *
 * @module dsh-deepseek-vision/vision
 */
import { VisionError, failureToVisionError, toVisionError } from './errors.js';
import { VisionCache, SingleFlight } from './cache.js';

/** 同一张图失败后的冷却时间：期间不再发起网络请求。 */
export const FAILURE_COOLDOWN_MS = 60_000;

/**
 * 构造一条只含图片与提示词的请求消息。
 * `attachment` 是持久图片引用（`ImageAttachmentRef`），由 `ctx.llm` 负责投影。
 * @param {object} ref 图片附件引用。
 * @param {string} prompt 提示词。
 * @returns {Array<object>} 请求消息数组。
 */
export function buildVisionMessages(ref, prompt) {
    return [{
        role: 'user',
        content: [
            { type: 'image', attachment: ref },
            { type: 'text', text: prompt },
        ],
    }];
}

/**
 * 发起一次识图请求并汇总流式文本。
 * @param {object} ctx 插件上下文（需要 `llm` 服务）。
 * @param {object} options 请求参数。
 * @param {string} options.provider 识图 provider 路由（默认 deepseek-account）。
 * @param {string} options.model 识图模型 id（默认 deepseek-flash）。
 * @param {object} options.ref 持久图片附件引用。
 * @param {string} options.prompt 提示词。
 * @param {number} options.maxTokens 输出上限。
 * @param {number} options.timeoutMs 超时。
 * @param {AbortSignal} [options.signal] 调用方取消信号。
 * @returns {Promise<{text: string, provider: string, model: string, truncated: boolean, usage: unknown}>}
 */
export async function recognizeImage(ctx, options) {
    const {
        provider,
        model,
        ref,
        prompt,
        maxTokens,
        timeoutMs,
        signal,
    } = options;
    if (signal?.aborted === true) throw new VisionError('识图请求已被取消', 'ABORTED');

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    let timedOut = false;
    timeoutSignal.addEventListener('abort', () => {
        timedOut = true;
    }, { once: true });
    const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

    /** @type {string} */
    let text = '';
    /** @type {string} */
    let blockText = '';
    /** @type {{ kind: string, failure?: object } | undefined} */
    let finish;
    /** @type {unknown} */
    let usage;

    try {
        for await (const chunk of ctx.llm.stream({
            provider,
            model,
            messages: buildVisionMessages(ref, prompt),
            maxTokens,
            signal: combined,
        })) {
            switch (chunk.type) {
                case 'text-delta':
                    text += chunk.text;
                    break;
                case 'block-end':
                    if (chunk.block?.type === 'text') blockText += chunk.block.text ?? '';
                    break;
                case 'usage':
                    usage = chunk.usage;
                    break;
                case 'finish':
                    finish = chunk.reason;
                    break;
                default:
                    // block-start / reasoning-delta / tool-call-delta：识图请求不带工具，忽略即可。
                    break;
            }
        }
    } catch (error) {
        if (timedOut) throw new VisionError(`识图请求超时（${timeoutMs}ms）`, 'TIMEOUT');
        if (signal?.aborted === true) throw new VisionError('识图请求已被取消', 'ABORTED');
        throw toVisionError(error, 'LLM_ERROR');
    }

    if (timedOut) throw new VisionError(`识图请求超时（${timeoutMs}ms）`, 'TIMEOUT');
    if (finish === undefined) throw new VisionError('识图请求没有返回终止状态', 'NO_FINISH');
    if (finish.kind === 'aborted') {
        if (signal?.aborted === true) throw new VisionError('识图请求已被取消', 'ABORTED');
        throw failureToVisionError(finish.failure, provider, model);
    }
    if (finish.kind === 'error') throw failureToVisionError(finish.failure, provider, model);
    if (finish.kind === 'tool-calls') throw new VisionError('识图请求意外触发了工具调用', 'UNEXPECTED_TOOL_CALL');

    const output = text.trim() !== '' ? text.trim() : blockText.trim();
    if (output === '') throw new VisionError('识图模型没有返回任何文本', 'EMPTY_RESPONSE');
    return {
        text: output,
        provider,
        model,
        truncated: finish.kind === 'max-tokens',
        usage,
    };
}

/**
 * 带缓存、失败冷却与并发合并的识图入口。
 * 自动转译（路由）与 `deepseek_vision` 工具共用这一层，避免重复计费。
 * @param {object} args 构造参数。
 * @param {object} args.ctx 插件上下文（需要 `llm` 服务）。
 * @param {object} args.resolved 归一化配置。
 * @returns {{analyze: Function, cache: VisionCache}}
 */
export function createVisionGateway({ ctx, resolved }) {
    const cache = new VisionCache(resolved.cacheSize);
    const inflight = new SingleFlight();
    /** @type {Map<string, {message: string, code: string, until: number}>} */
    const failures = new Map();

    /**
     * @param {object} request 识图请求。
     * @param {string} request.key 缓存键（图片内容 + 提示词）。
     * @param {object} request.ref 持久图片附件引用。
     * @param {string} request.prompt 提示词。
     * @param {AbortSignal} [request.signal] 取消信号。
     * @returns {Promise<{text: string, provider: string, model: string, truncated: boolean, cached: boolean}>}
     */
    async function analyze({ key, ref, prompt, signal }) {
        const hit = cache.get(key);
        if (hit !== undefined) return { .../** @type {object} */ (hit), cached: true };

        const failed = failures.get(key);
        if (failed !== undefined) {
            if (failed.until > Date.now()) {
                throw new VisionError(failed.message, failed.code, '上一次识图刚失败，短暂冷却中');
            }
            failures.delete(key);
        }

        return inflight.run(key, async () => {
            const again = cache.get(key);
            if (again !== undefined) return { .../** @type {object} */ (again), cached: true };
            try {
                const result = await recognizeImage(ctx, {
                    provider: resolved.visionProvider,
                    model: resolved.visionModel,
                    ref,
                    prompt,
                    maxTokens: resolved.visionMaxTokens,
                    timeoutMs: resolved.timeoutMs,
                    signal,
                });
                const value = {
                    text: result.text,
                    provider: result.provider,
                    model: result.model,
                    truncated: result.truncated,
                    usage: result.usage,
                };
                cache.set(key, value);
                failures.delete(key);
                return { ...value, cached: false };
            } catch (error) {
                const visionError = toVisionError(error);
                failures.set(key, {
                    message: visionError.message,
                    code: visionError.code,
                    until: Date.now() + FAILURE_COOLDOWN_MS,
                });
                throw visionError;
            }
        });
    }

    return { analyze, cache };
}
