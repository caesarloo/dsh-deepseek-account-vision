import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../lib/index.js';
import { resolveConfig } from '../lib/config.js';
import { createVisionGateway } from '../lib/vision.js';
import { createVisionTool } from '../lib/tool.js';
import { PNG_BYTES, createFakeContext } from './fake-context.js';

const EXEC = { signal: undefined, agent: undefined };

function setupTool(options = {}) {
    const files = new Map([['C:/img/a.png', PNG_BYTES]]);
    const fake = createFakeContext({ files, ...options });
    const resolved = resolveConfig(options.config ?? {});
    const gateway = createVisionGateway({ ctx: fake.ctx, resolved });
    const tool = createVisionTool({ ctx: fake.ctx, resolved, gateway });
    return { fake, resolved, gateway, tool };
}

test('deepseek_vision：读本地图片 → 保存附件 → 用 deepseek-flash 识图', async () => {
    const { fake, tool } = setupTool({ visionText: '识别结果：一张透明小图' });
    const value = await tool.execute({ image_path: 'C:/img/a.png' }, EXEC);
    assert.equal(value.text, '识别结果：一张透明小图');
    assert.equal(value.model, 'deepseek-flash');
    assert.equal(value.source, 'C:/img/a.png');
    assert.equal(value.truncated, false);

    assert.equal(fake.llmRequests.length, 1);
    assert.equal(fake.llmRequests[0].provider, 'deepseek-account');
    assert.equal(fake.llmRequests[0].model, 'deepseek-flash');
    assert.equal(fake.llmRequests[0].messages[0].content[0].type, 'image');
    assert.ok(fake.attachments.store.size >= 1, '图片应已保存为持久附件');
});

test('deepseek_vision：同图同提示词命中缓存，不重复识图', async () => {
    const { fake, tool } = setupTool();
    const first = await tool.execute({ image_path: 'C:/img/a.png' }, EXEC);
    const second = await tool.execute({ image_path: 'C:/img/a.png' }, EXEC);
    assert.equal(first.text, second.text);
    assert.equal(fake.llmRequests.length, 1);
});

test('deepseek_vision：自定义 prompt 会进入识图请求', async () => {
    const { fake, tool } = setupTool();
    await tool.execute({ image_path: 'C:/img/a.png', prompt: '只识别图中的文字' }, EXEC);
    const text = fake.llmRequests[0].messages[0].content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
    assert.match(text, /只识别图中的文字/);
    assert.match(text, /优先回答上面的问题/);
});

test('deepseek_vision：支持 http(s) 图片 URL', async () => {
    const { fake, tool } = setupTool();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        headers: {
            get: (name) => (String(name).toLowerCase() === 'content-type' ? 'image/png' : null),
        },
        arrayBuffer: async () => PNG_BYTES.slice().buffer,
    });
    try {
        const value = await tool.execute({ image_url: 'https://example.com/a.png' }, EXEC);
        assert.equal(value.text, '识图结果：一张 1x1 的透明 PNG。');
        assert.equal(value.source, 'https://example.com/a.png');
        assert.equal(fake.llmRequests.length, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('deepseek_vision：参数校验——必须且只能二选一', async () => {
    const { tool } = setupTool();
    await assert.rejects(tool.execute({}, EXEC), /必须提供 image_path 或 image_url/);
    await assert.rejects(tool.execute({ image_path: 'a.png', image_url: 'https://example.com/a.png' }, EXEC), /只能提供一个/);
});

test('deepseek_vision：不支持的扩展名会被拒绝', async () => {
    const files = new Map([['C:/img/a.txt', PNG_BYTES]]);
    const fake = createFakeContext({ files });
    const resolved = resolveConfig();
    const gateway = createVisionGateway({ ctx: fake.ctx, resolved });
    const tool = createVisionTool({ ctx: fake.ctx, resolved, gateway });
    await assert.rejects(tool.execute({ image_path: 'C:/img/a.txt' }, EXEC), /不支持的图片扩展名/);
});

test('插件装配：默认注册 deepseek_vision 工具与 deepseek-account-vision 路由', async () => {
    const fake = createFakeContext();
    apply(fake.ctx, {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(fake.registeredTools.length, 1);
    assert.equal(fake.registeredTools[0].name, 'deepseek_vision');
    assert.equal(fake.registeredTools[0].output.render instanceof Function, true);

    assert.ok(fake.registeredAdapters.has('deepseek-account-vision'));
    const adapter = fake.registeredAdapters.get('deepseek-account-vision');
    const info = await adapter.resolveModel('deepseek-account-vision', 'deepseek-v4-pro');
    assert.deepEqual(info.inputModalities, ['text', 'image']);
    assert.match(adapter.providerInfo('deepseek-account-vision').name, /DeepSeek 识图/);
});

test('插件装配：完全关闭时不注册任何东西', async () => {
    const fake = createFakeContext();
    apply(fake.ctx, { tool: false, autoTranscribe: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fake.registeredTools.length, 0);
    assert.equal(fake.registeredAdapters.size, 0);
});

test('插件装配：wrapAllProviders=false 时只包裹 innerProviders', async () => {
    const fake = createFakeContext({
        providers: [
            { id: 'deepseek-account', name: 'DeepSeek' },
            { id: 'pi-ai', name: 'Pi AI' },
        ],
    });
    apply(fake.ctx, { wrapAllProviders: false, innerProviders: ['pi-ai'] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual([...fake.registeredAdapters.keys()], ['pi-ai-vision']);
});

test('插件装配：动态注册的新 provider 会被自动包裹', async () => {
    const fake = createFakeContext();
    apply(fake.ctx, {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(fake.registeredAdapters.has('deepseek-account-vision'));

    fake.providers.push({ id: 'pi-ai', name: 'Pi AI' });
    fake.emit('llm/adapters-updated');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(fake.registeredAdapters.has('pi-ai-vision'));
});
