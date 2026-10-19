import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveConfig } from '../lib/config.js';
import { VisionError } from '../lib/errors.js';
import { createVisionGateway, recognizeImage } from '../lib/vision.js';
import { PNG_BYTES, createFakeAttachments, createFakeContext } from './fake-context.js';

function refForAttachments() {
    const attachments = createFakeAttachments();
    return attachments.saveImage({ data: PNG_BYTES, mediaType: 'image/png', name: 'x.png' })
        .then((ref) => ({ attachments, ref }));
}

test('recognizeImage：汇总 text-delta 并返回识图文本', async () => {
    const fake = createFakeContext({ visionText: '图片里写着 Hello' });
    const { ref } = await refForAttachments();
    const result = await recognizeImage(fake.ctx, {
        provider: 'deepseek-account',
        model: 'deepseek-flash',
        ref,
        prompt: '识图',
        maxTokens: 512,
        timeoutMs: 1_000,
    });
    assert.equal(result.text, '图片里写着 Hello');
    assert.equal(result.provider, 'deepseek-account');
    assert.equal(result.model, 'deepseek-flash');
    assert.equal(result.truncated, false);
    assert.equal(fake.llmRequests.length, 1);
    assert.equal(fake.llmRequests[0].provider, 'deepseek-account');
    assert.equal(fake.llmRequests[0].model, 'deepseek-flash');
    assert.equal(fake.llmRequests[0].maxTokens, 512);
    const content = fake.llmRequests[0].messages[0].content;
    assert.equal(content[0].type, 'image');
    assert.equal(content[1].type, 'text');
});

test('recognizeImage：block-end 文本可作为 delta 缺失时的兜底', async () => {
    const fake = createFakeContext({
        stream: () => (async function* () {
            yield { type: 'block-end', index: 0, block: { type: 'text', text: '仅 block-end 的文本' } };
            yield { type: 'finish', reason: { kind: 'stop' } };
        })(),
    });
    const { ref } = await refForAttachments();
    const result = await recognizeImage(fake.ctx, {
        provider: 'deepseek-account', model: 'deepseek-flash', ref, prompt: 'p', maxTokens: 64, timeoutMs: 1_000,
    });
    assert.equal(result.text, '仅 block-end 的文本');
});

test('recognizeImage：max-tokens 标记截断但不丢文本', async () => {
    const fake = createFakeContext({
        stream: () => (async function* () {
            yield { type: 'text-delta', text: '半截文本' };
            yield { type: 'finish', reason: { kind: 'max-tokens' } };
        })(),
    });
    const { ref } = await refForAttachments();
    const result = await recognizeImage(fake.ctx, {
        provider: 'deepseek-account', model: 'deepseek-flash', ref, prompt: 'p', maxTokens: 64, timeoutMs: 1_000,
    });
    assert.equal(result.truncated, true);
    assert.equal(result.text, '半截文本');
});

test('recognizeImage：error 终止按错误码分类并附中文提示', async () => {
    const fake = createFakeContext({
        stream: () => (async function* () {
            yield { type: 'finish', reason: { kind: 'error', failure: { code: 'ACCOUNT_SIGN_IN_REQUIRED', message: 'not signed in' } } };
        })(),
    });
    const { ref } = await refForAttachments();
    await assert.rejects(
        recognizeImage(fake.ctx, { provider: 'deepseek-account', model: 'deepseek-flash', ref, prompt: 'p', maxTokens: 64, timeoutMs: 1_000 }),
        (error) => {
            assert.ok(error instanceof VisionError);
            assert.equal(error.code, 'ACCOUNT_SIGN_IN_REQUIRED');
            assert.match(error.message, /登录 DeepSeek 账号/);
            return true;
        },
    );
});

test('recognizeImage：超时会快速失败（不会卡死）', async () => {
    const fake = createFakeContext({
        stream: () => (async function* () {
            await new Promise((resolve) => setTimeout(resolve, 120));
            yield { type: 'finish', reason: { kind: 'stop' } };
        })(),
    });
    const { ref } = await refForAttachments();
    await assert.rejects(
        recognizeImage(fake.ctx, { provider: 'deepseek-account', model: 'deepseek-flash', ref, prompt: 'p', maxTokens: 64, timeoutMs: 20 }),
        (error) => {
            assert.equal(error.code, 'TIMEOUT');
            return true;
        },
    );
});

test('gateway：同一图片命中缓存，只发一次识图请求', async () => {
    const fake = createFakeContext({ visionText: '缓存命中的识图结果' });
    const resolved = resolveConfig();
    const gateway = createVisionGateway({ ctx: fake.ctx, resolved });
    const { ref } = await refForAttachments();
    const first = await gateway.analyze({ key: 'k1', ref, prompt: 'p' });
    const second = await gateway.analyze({ key: 'k1', ref, prompt: 'p' });
    assert.equal(first.text, '缓存命中的识图结果');
    assert.equal(second.text, '缓存命中的识图结果');
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(fake.llmRequests.length, 1);
});

test('gateway：失败后进入冷却，冷却期内不再发起请求', async () => {
    let calls = 0;
    const fake = createFakeContext({
        stream: () => {
            calls += 1;
            return (async function* () {
                yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } } };
            })();
        },
    });
    const resolved = resolveConfig();
    const gateway = createVisionGateway({ ctx: fake.ctx, resolved });
    const { ref } = await refForAttachments();
    await assert.rejects(gateway.analyze({ key: 'k2', ref, prompt: 'p' }), /RATE_LIMIT/);
    await assert.rejects(gateway.analyze({ key: 'k2', ref, prompt: 'p' }), (error) => {
        assert.equal(error.code, 'RATE_LIMIT');
        assert.match(error.message, /冷却/);
        return true;
    });
    assert.equal(calls, 1);
});

test('gateway：并发同键请求合并成一次调用', async () => {
    let calls = 0;
    const fake = createFakeContext({
        stream: () => {
            calls += 1;
            return (async function* () {
                await new Promise((resolve) => setTimeout(resolve, 10));
                yield { type: 'text-delta', text: '并发合并结果' };
                yield { type: 'finish', reason: { kind: 'stop' } };
            })();
        },
    });
    const resolved = resolveConfig();
    const gateway = createVisionGateway({ ctx: fake.ctx, resolved });
    const { ref } = await refForAttachments();
    const [a, b] = await Promise.all([
        gateway.analyze({ key: 'k3', ref, prompt: 'p' }),
        gateway.analyze({ key: 'k3', ref, prompt: 'p' }),
    ]);
    assert.equal(a.text, '并发合并结果');
    assert.equal(b.text, '并发合并结果');
    assert.equal(calls, 1);
});
