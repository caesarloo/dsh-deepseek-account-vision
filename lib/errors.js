/**
 * 识图失败的分类与可操作提示。
 *
 * `ctx.llm.stream()` 的终止 `finish` 分片携带规范化后的 `LlmFailure`
 * （稳定 code + message + status）。本模块只依据 code 分支，不解析 message 文本。
 *
 * @module dsh-deepseek-vision/errors
 */

/** 识图失败。`code` 为稳定错误码，`hint` 为可操作的中文提示。 */
export class VisionError extends Error {
    /**
     * @param {string} message 面向诊断的错误信息。
     * @param {string} code 稳定错误码。
     * @param {string} [hint] 面向用户的可操作提示。
     */
    constructor(message, code, hint) {
        super(hint === undefined ? message : `${message}（${hint}）`);
        this.name = 'VisionError';
        this.code = code;
        this.hint = hint;
    }
}

/** 失败码 → 可操作提示。未列出的码保留原始 message。 */
const HINTS = {
    ACCOUNT_SIGN_IN_REQUIRED: '请先在 DSH 里登录 DeepSeek 账号（设置 → 账号）；登录后即可直接识图，无需 API Key',
    NO_ADAPTER: 'visionProvider 指向的模型路由没有注册；检查插件配置里的 visionProvider',
    MISSING_CREDENTIAL: 'DeepSeek 账号凭据缺失，请重新登录 DeepSeek 账号',
    AUTH: 'DeepSeek 账号登录已失效，请重新登录账号',
    ACCOUNT_TOKEN_INVALID: 'DeepSeek 账号登录已失效，请重新登录账号',
    INVALID_CREDENTIAL: 'DeepSeek 账号凭据无效，请重新登录账号',
    RATE_LIMIT: '识图请求被限流，请稍后重试',
    QUOTA: '识图模型额度不足，请检查 DeepSeek 账号额度',
    ACCOUNT_QUOTA: 'DeepSeek 账号余额不足，请充值后重试',
    CONTEXT_WINDOW_EXCEEDED: '图片太大或上下文超限，请换更小的图片重试',
    IMAGE_OFFLOAD_REQUIRED: '图片体积超出该模型的请求预算，请换更小的图片重试',
    MODEL_UNSUPPORTED: '当前账号/DSH 版本不支持该识图模型，请检查 visionModel 或升级 DSH',
    CLIENT_UPGRADE_REQUIRED: '该识图模型要求更高的 DSH 版本，请升级 DSH',
    UNKNOWN_MODEL: '识图模型 id 不被该路由认识，请检查 visionModel',
    TIMEOUT: '识图请求超时，请检查网络后重试',
    ABORTED: '识图请求被取消',
    EMPTY_RESPONSE: '识图模型没有返回任何文本，请换个提示词或换张图片重试',
    NO_FINISH: '识图请求没有正常结束，请重试',
};

/**
 * 把 `finish.failure` 映射成 `VisionError`。
 * @param {{ code?: string, message?: string, status?: number } | undefined} failure 终止失败信息。
 * @param {string} provider 识图 provider id。
 * @param {string} model 识图 model id。
 * @returns {VisionError}
 */
export function failureToVisionError(failure, provider, model) {
    const code = typeof failure?.code === 'string' && failure.code !== '' ? failure.code : 'LLM_ERROR';
    const detail = typeof failure?.message === 'string' && failure.message !== '' ? failure.message : 'no failure message';
    const status = typeof failure?.status === 'number' ? ` HTTP ${failure.status}` : '';
    const message = `识图模型 ${provider}/${model} 调用失败 [${code}${status}]: ${detail}`;
    const hint = HINTS[code];
    return new VisionError(message, code, hint);
}

/**
 * 把任意异常归一化为 `VisionError`（用于工具错误与占位文本）。
 * @param {unknown} error 原始异常。
 * @param {string} [fallbackCode] 无法识别时使用的错误码。
 * @returns {VisionError}
 */
export function toVisionError(error, fallbackCode = 'VISION_FAILED') {
    if (error instanceof VisionError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new VisionError(`识图失败: ${message}`, fallbackCode);
}

/** 生成自动转译占位文本（不把整段错误堆栈塞进会话历史）。 */
export function failurePlaceholder(error) {
    const visionError = toVisionError(error);
    const reason = visionError.message.length > 240 ? `${visionError.message.slice(0, 240)}…` : visionError.message;
    return `[图片转译失败: ${reason}]`;
}
