import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveConfig } from '../lib/config.js';
import { createVisionGateway } from '../lib/vision.js';
import { createVisionAdapter, hasImageContent, transcribeMessages } from '../lib/route.js';
import { PNG_BYTES, createFakeContext } from './fake-context.js';

async function setup(options = {}) {
    const fake = createFakeContext(options);
    const resolved = resolveConfig(options.config ?? {});
    const gateway = createVisionGateway({ ctx: fake.ctx, resolved });
    const adapter = createVisionAdapter({
        ctx: fake.ctx,
        resolved,
        gateway,
        innerProvider: 'deepseek-account',
        innerName: 'DeepSeek',
    });
    const ref = await fake.attachments.saveImage({ data: PNG_BYTES, mediaType: 'image/png', name: 'x.png' });
    return { fake, resolved, gateway, adapter, ref };
}

function userMessage(ref, text = '这张图里有什么？') {
    return {
        role: 'user',
        id: 'm-user',
        source: { kind: 'user' },
        content: [
            { type: 'text', text },
            { type: 'image', attachment: ref },
        ],
    };
}

async function drain(iterable) {
    const chunks = [];
    for await (const chunk of iterable) chunks.push(chunk);
    return chunks;
}

test('hasImageContent：识别图片块与 tool-result 嵌套（兼容旧结构）', () => {
    assert.equal(hasImageContent([{ type: 'text', text: 'x' }]), false);
    assert.equal(hasImageContent([{ type: 'image', attachment: {} }]), true);
    assert.equal(hasImageContent([{ type: 'tool-result', content: [{ type: 'image', attachment: {} }] }]), true);
});

test('代理路由对外声明图片输入，模型目录沿用原 provider', async () => {
    const { adapter } = await setup();
    const models = await adapter.listModels('deepseek-account-vision');
    assert.equal(models.length, 1);
    assert.equal(models[0].provider, 'deepseek-account-vision');

    const info = await adapter.resolveModel('deepseek-account-vision', 'deepseek-v4-pro');
    assert.deepEqual(info.inputModalities, ['text', 'image']);
    assert.equal(info.provider, 'deepseek-account-vision');
});

test('代理路由：把图片转译成文字后委托给原模型，原模型收不到图片块', async () => {
    const { fake, adapter, ref } = await setup({ visionText: '图里写着 Hello World' });
    const prepared = await adapter.prepareCall('deepseek-account-vision', 'deepseek-v4-pro');
    assert.deepEqual(prepared.model.inputModalities, ['text', 'image']);

    const chunks = await drain(prepared.stream({
        provider: 'deepseek-account-vision',
        model: 'deepseek-v4-pro',
        messages: [userMessage(ref)],
    }));

    // 识图请求打到了 DeepSeek 账号路由的 deepseek-flash
    assert.equal(fake.llmRequests.length, 1);
    assert.equal(fake.llmRequests[0].provider, 'deepseek-account');
    assert.equal(fake.llmRequests[0].model, 'deepseek-flash');
    assert.equal(fake.llmRequests[0].messages[0].content[0].type, 'image');

    // 委托给原 provider，消息里只剩文字
    assert.equal(fake.inner.delegated.length, 1);
    const delegated = fake.inner.delegated[0];
    assert.equal(delegated.provider, 'deepseek-account');
    assert.equal(delegated.model, 'deepseek-v4-pro');
    const blocks = delegated.messages[0].content;
    assert.equal(blocks.some((block) => block.type === 'image'), false);
    const textBlocks = blocks.filter((block) => block.type === 'text').map((block) => block.text);
    assert.ok(textBlocks.some((text) => text.includes('[图片转译]')));
    assert.ok(textBlocks.some((text) => text.includes('图里写着 Hello World')));

    // 原模型的回答原样透传
    assert.ok(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text.includes('主模型基于转译回答')));
    assert.equal(chunks.at(-1).type, 'finish');
});

test('代理路由：同一张图在历史里出现多次只识图一次（内容哈希缓存）', async () => {
    const { fake, adapter, ref } = await setup({ visionText: '同一张图' });
    const prepared = await adapter.prepareCall('deepseek-account-vision', 'deepseek-v4-pro');
    await drain(prepared.stream({
        provider: 'deepseek-account-vision',
        model: 'deepseek-v4-pro',
        messages: [userMessage(ref), userMessage(ref, '再看一次')],
    }));
    assert.equal(fake.llmRequests.length, 1, '同一内容哈希只应识图一次');
});

test('代理路由：识图失败时插入占位文本并继续（failureMode=placeholder）', async () => {
    const { fake, adapter, ref } = await setup({
        config: { failureMode: 'placeholder' },
        stream: () => (async function* () {
            yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } } };
        })(),
    });
    const prepared = await adapter.prepareCall('deepseek-account-vision', 'deepseek-v4-pro');
    await drain(prepared.stream({
        provider: 'deepseek-account-vision',
        model: 'deepseek-v4-pro',
        messages: [userMessage(ref)],
    }));
    assert.equal(fake.inner.delegated.length, 1, '失败不应阻断主对话');
    const blocks = fake.inner.delegated[0].messages[0].content;
    assert.ok(blocks.some((block) => block.type === 'text' && block.text.includes('[图片转译失败')));
});

test('代理路由：failureMode=error 时整轮失败', async () => {
    const { adapter, ref } = await setup({
        config: { failureMode: 'error' },
        stream: () => (async function* () {
            yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } } };
        })(),
    });
    const prepared = await adapter.prepareCall('deepseek-account-vision', 'deepseek-v4-pro');
    await assert.rejects(
        drain(prepared.stream({
            provider: 'deepseek-account-vision',
            model: 'deepseek-v4-pro',
            messages: [userMessage(ref)],
        })),
        /RATE_LIMIT/,
    );
});

test('transcribeMessages：纯文本消息原样返回同一引用（零开销直达）', async () => {
    const { fake, resolved, gateway } = await setup();
    const messages = [{ role: 'user', id: 'm', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }];
    const out = await transcribeMessages({ ctx: fake.ctx, resolved, gateway, messages });
    assert.equal(out, messages);
});
