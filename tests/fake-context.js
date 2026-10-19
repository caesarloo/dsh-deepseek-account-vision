/**
 * 测试用的假 Cordis 上下文 / 服务。
 * 只实现被测代码真正用到的那一小片 API，避免把测试绑到 DSH 内部实现上。
 */
import { createHash } from 'node:crypto';

/** 1x1 透明 PNG。 */
export const PNG_BYTES = Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
));

/** 一张假 JPEG 的字节（只需签名能被嗅探即可）。 */
export const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

export function sha256(data) {
    return createHash('sha256').update(data).digest('hex');
}

/**
 * 假附件服务：saveImage 留存字节，readImage 读回，便于路由层按哈希缓存。
 */
export function createFakeAttachments() {
    /** @type {Map<string, {data: Uint8Array, mediaType: string, name?: string}>} */
    const store = new Map();
    return {
        imageLimits: {
            mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
            maxImageBytes: 10 * 1024 * 1024,
            maxMessageImageBytes: 10 * 1024 * 1024,
            maxImagePixels: 10_000_000,
            maxImageDimension: 8_000,
        },
        store,
        async saveImage({ data, mediaType, name }) {
            const attachmentId = `att_${sha256(data).slice(0, 16)}`;
            store.set(attachmentId, { data: Uint8Array.from(data), mediaType, name });
            return {
                attachmentId,
                mediaType,
                bytes: data.byteLength,
                width: 1,
                height: 1,
                ...(name === undefined ? {} : { name }),
            };
        },
        async readImage(ref) {
            const stored = store.get(ref.attachmentId);
            if (stored === undefined) {
                const error = new Error(`attachment ${ref.attachmentId} not found`);
                error.code = 'ATTACHMENT_NOT_FOUND';
                throw error;
            }
            return { ref, data: stored.data };
        },
    };
}

/**
 * 假 inner adapter：记录被委托的请求，并返回固定文本流。
 */
export function createFakeInnerAdapter({ model = { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', provider: 'deepseek-account', inputModalities: ['text'] } } = {}) {
    /** @type {object[]} */
    const delegated = [];
    const adapter = {
        providerInfo: (id) => ({ id, name: 'DeepSeek' }),
        providerRetryPolicy: () => undefined,
        imageRequestPricing: () => undefined,
        imageRequestTarget: (_provider, _model, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
        listModels: async () => [{ id: model.id, name: model.name, provider: 'deepseek-account' }],
        resolveModel: async (provider, id) => ({ ...model, provider, id, name: model.name }),
        prepareCall: async (provider, id) => ({
            model: { ...model, provider, id, name: model.name },
            stream: async function* (options) {
                delegated.push(options);
                yield { type: 'text-delta', text: '主模型基于转译回答' };
                yield { type: 'finish', reason: { kind: 'stop' } };
            },
        }),
        stream: async function* (options) {
            delegated.push(options);
            yield { type: 'finish', reason: { kind: 'stop' } };
        },
    };
    return { adapter, delegated };
}

/**
 * 构造假上下文。
 * @param {object} [options] 覆盖项。
 */
export function createFakeContext(options = {}) {
    const logs = { info: [], warn: [], error: [], debug: [] };
    const listeners = new Map();
    const registeredTools = [];
    const registeredAdapters = new Map();
    const llmRequests = [];
    const providers = [...(options.providers ?? [{ id: 'deepseek-account', name: 'DeepSeek' }])];
    const inner = options.inner ?? createFakeInnerAdapter();
    const attachments = options.attachments ?? createFakeAttachments();
    const files = options.files ?? new Map();
    const services = new Map();

    const emit = (event) => {
        for (const listener of listeners.get(event) ?? []) listener();
    };

    const llm = {
        listProviders: () => providers.map((provider) => ({ ...provider })),
        registration: (provider) => {
            const found = providers.find((entry) => entry.id === provider);
            if (found === undefined) {
                const error = new Error(`no adapter registered for provider "${provider}"`);
                error.code = 'NO_ADAPTER';
                throw error;
            }
            return { adapter: inner.adapter, provider: found };
        },
        registerAdapter: (ids, adapter) => {
            for (const id of ids) {
                registeredAdapters.set(id, adapter);
                providers.push({ id, name: adapter.providerInfo(id).name });
            }
            emit('llm/adapters-updated');
            return () => {};
        },
        stream: (request) => {
            llmRequests.push(request);
            if (options.stream !== undefined) return options.stream(request);
            const text = options.visionText ?? '识图结果：一张 1x1 的透明 PNG。';
            return (async function* () {
                yield { type: 'text-delta', text };
                yield { type: 'usage', usage: { input: 1, output: 1 } };
                yield { type: 'finish', reason: { kind: 'stop' } };
            })();
        },
    };
    services.set('llm', llm);
    services.set('attachments', attachments);

    const fs = {
        resolve: async (path) => ({ targetKey: path, displayPath: path }),
        stat: async (target) => (files.has(target.displayPath) ? { type: 'file', version: 'v1' } : undefined),
        readBytes: async (target, _signal, cap) => {
            const bytes = files.get(target.displayPath);
            if (bytes === undefined) {
                const error = new Error('not found');
                error.code = 'FS_NOT_FOUND';
                throw error;
            }
            if (bytes.byteLength > cap) {
                const error = new Error('too large');
                error.code = 'FS_TOO_LARGE';
                throw error;
            }
            return bytes;
        },
    };
    services.set('fs', fs);
    const workingDirectory = {
        ensure: async () => 'C:/work',
    };
    services.set('workingDirectory', workingDirectory);

    const ctx = {
        logger: {
            info: (message) => logs.info.push(String(message)),
            warn: (message) => logs.warn.push(String(message)),
            error: (message) => logs.error.push(String(message)),
            debug: (message) => logs.debug.push(String(message)),
        },
        get: (name) => services.get(name),
        inject: (_deps, callback) => {
            callback(ctx);
            return () => {};
        },
        on: (event, listener) => {
            const list = listeners.get(event) ?? [];
            list.push(listener);
            listeners.set(event, list);
            return () => {};
        },
        workingDirectory,
        tools: {
            register: (definition) => {
                registeredTools.push(definition);
                return () => {};
            },
        },
        llm,
        attachments,
        fs,
    };

    return {
        ctx,
        logs,
        llm,
        llmRequests,
        attachments,
        files,
        providers,
        registeredTools,
        registeredAdapters,
        listeners,
        emit,
        inner,
    };
}
