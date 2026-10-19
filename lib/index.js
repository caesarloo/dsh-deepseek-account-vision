/**
 * dsh-deepseek-vision 插件入口。
 *
 * 给“任意主模型”补上视觉能力，识图后端是 DeepSeek 账号自带的
 * DeepSeek-V4.1-Flash（`deepseek-flash`，1017 版，原生多模态）：
 *
 * 1. `deepseek_vision` 工具 —— 主模型（哪怕纯文本）直接调用它识别一张图片
 *    （本地路径或 http(s) URL），拿回完整文字转译；
 * 2. 自动转译路由 —— 给每个已注册 provider 包一层 `<provider>-vision` 路由，
 *    在 GUI 里给纯文本主模型贴图时，图片先被转译成文字再交给原模型。
 *
 * 两者共用同一个识图网关：DeepSeek 账号登录态、内容哈希缓存、失败冷却、
 * 同图并发合并。插件不需要、也不保存任何 API Key。
 *
 * @module dsh-deepseek-vision
 */
import { Config, resolveConfig } from './config.js';
import { createVisionGateway } from './vision.js';
import { createVisionTool } from './tool.js';
import { createVisionAdapter } from './route.js';

export const name = 'dsh-deepseek-vision';

/** 本插件强依赖的宿主服务：模型调用与附件存储。 */
export const inject = ['llm', 'attachments'];

export { Config };
export { resolveConfig };

/** 把错误压成一行日志文本（插件日志不打印堆栈与密钥）。 */
function oneLine(error) {
    return (error instanceof Error ? error.message : String(error)).split('\n')[0];
}

/**
 * 插件主体。
 * @param {object} ctx Cordis 插件上下文。
 * @param {object} [config] bundle patch / profile 覆盖层给出的配置。
 */
export function apply(ctx, config = {}) {
    const resolved = resolveConfig(config);
    const gateway = createVisionGateway({ ctx, resolved });
    /** 本插件注册的识图路由 id。 */
    const ownRoutes = new Set();
    /** 已经包裹过的 inner provider id。 */
    const wrappedProviders = new Set();

    ctx.logger.info(`dsh-deepseek-vision: 识图后端 ${resolved.visionProvider}/${resolved.visionModel} · 工具 ${resolved.tool ? resolved.toolName : 'off'} · 自动转译 ${resolved.autoTranscribe ? (resolved.wrapAllProviders ? '全部 provider' : (resolved.innerProviders.join(', ') || 'off')) : 'off'} · failureMode ${resolved.failureMode}`);
    ctx.logger.info('dsh-deepseek-vision: 无需 API Key，识图复用 DeepSeek 账号登录态；图片仅随识图请求发送到 DeepSeek，插件不落盘、不记录密钥。');

    // ---- 工具：deepseek_vision -------------------------------------------------
    if (resolved.tool) {
        ctx.inject(['tools', 'fs', 'workingDirectory'], (toolCtx) => {
            const tool = createVisionTool({ ctx: toolCtx, resolved, gateway });
            toolCtx.tools.register(tool);
            ctx.logger.info(`dsh-deepseek-vision: 已注册工具 ${resolved.toolName}（任意主模型可调用）`);
        });
    }

    // ---- 自动转译路由 ----------------------------------------------------------
    if (resolved.autoTranscribe) {
        /**
         * 为一个 provider 注册识图路由。
         * @param {string} providerId 被包裹的 provider 路由 id。
         * @returns {boolean} 是否新注册。
         */
        const wrapProvider = (providerId) => {
            if (ownRoutes.has(providerId)) return false;
            if (wrappedProviders.has(providerId)) return false;
            const routeId = `${providerId}${resolved.routeSuffix}`;
            if (routeId === providerId || ownRoutes.has(routeId)) return false;

            const providers = ctx.llm.listProviders();
            const target = providers.find((provider) => provider.id === providerId);
            if (target === undefined) return false;
            // 该路由已被别的插件注册：不抢占。
            if (providers.some((provider) => provider.id === routeId)) {
                wrappedProviders.add(providerId);
                return false;
            }

            try {
                const adapter = createVisionAdapter({
                    ctx,
                    resolved,
                    gateway,
                    innerProvider: providerId,
                    innerName: target.name,
                });
                ctx.llm.registerAdapter([routeId], adapter);
            } catch (error) {
                ctx.logger.warn(`dsh-deepseek-vision: 注册识图路由 "${routeId}" 失败（包裹 "${providerId}"）: ${oneLine(error)}`);
                return false;
            }
            ownRoutes.add(routeId);
            wrappedProviders.add(providerId);
            ctx.logger.info(`dsh-deepseek-vision: 识图路由 "${routeId}" 已包裹 "${providerId}"（${target.name}）`);
            return true;
        };

        const wrapConfigured = () => {
            if (resolved.wrapAllProviders) {
                for (const provider of ctx.llm.listProviders()) wrapProvider(provider.id);
                return;
            }
            for (const providerId of resolved.innerProviders) wrapProvider(providerId);
        };

        wrapConfigured();

        if (resolved.wrapAllProviders) {
            // 之后动态注册的 provider（例如新启用的 pi-ai 路由）也自动包裹。
            // 放到微任务里：registerAdapter 会在提交时同步广播本事件，避免重入。
            ctx.on('llm/adapters-updated', () => {
                queueMicrotask(() => {
                    try {
                        wrapConfigured();
                    } catch (error) {
                        ctx.logger.warn(`dsh-deepseek-vision: 处理 llm/adapters-updated 失败: ${oneLine(error)}`);
                    }
                });
            });
        }

        if (ownRoutes.size === 0) {
            ctx.logger.warn('dsh-deepseek-vision: 没有注册任何识图路由（没有可包裹的 provider，或它们已被占用）；deepseek_vision 工具仍可用');
        }
    }
}

/** 单测接缝：仅供测试使用，不属于稳定 API。 */
export const _test = {
    resolveConfig,
    createVisionGateway,
    createVisionTool,
    createVisionAdapter,
};
