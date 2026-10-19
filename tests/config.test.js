import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_MARKER,
    DEFAULT_TOOL_NAME,
    DEFAULT_VISION_MODEL,
    DEFAULT_VISION_PROVIDER,
    resolveConfig,
} from '../lib/config.js';

test('默认配置：用 DeepSeek 账号的 DeepSeek-V4.1-Flash 识图，开工具与自动转译', () => {
    const resolved = resolveConfig();
    assert.equal(resolved.visionProvider, DEFAULT_VISION_PROVIDER);
    assert.equal(resolved.visionModel, DEFAULT_VISION_MODEL);
    assert.equal(resolved.visionProvider, 'deepseek-account');
    assert.equal(resolved.visionModel, 'deepseek-flash');
    assert.equal(resolved.tool, true);
    assert.equal(resolved.toolName, DEFAULT_TOOL_NAME);
    assert.equal(resolved.autoTranscribe, true);
    assert.equal(resolved.wrapAllProviders, true);
    assert.equal(resolved.marker, DEFAULT_MARKER);
    assert.equal(resolved.failureMode, 'placeholder');
    assert.equal(resolved.timeoutMs, 120_000);
    assert.equal(resolved.cacheSize, 200);
});

test('部分配置：未给出的键回落默认值', () => {
    const resolved = resolveConfig({ visionModel: 'deepseek-v4-pro' });
    assert.equal(resolved.visionModel, 'deepseek-v4-pro');
    assert.equal(resolved.visionProvider, 'deepseek-account');
    assert.equal(resolved.failureMode, 'placeholder');
});

test('显式关闭工具与自动转译', () => {
    const resolved = resolveConfig({ tool: false, autoTranscribe: false, innerProviders: ['pi-ai'] });
    assert.equal(resolved.tool, false);
    assert.equal(resolved.autoTranscribe, false);
    assert.deepEqual([...resolved.innerProviders], ['pi-ai']);
});

test('非法配置会被拒绝', () => {
    assert.throws(() => resolveConfig({ failureMode: 'ignore' }), /failureMode/);
    assert.throws(() => resolveConfig({ visionProvider: '' }), /visionProvider/);
    assert.throws(() => resolveConfig({ visionModel: '  ' }), /visionModel/);
    assert.throws(() => resolveConfig({ timeoutMs: 10 }), /timeoutMs/);
    assert.throws(() => resolveConfig({ cacheSize: -1 }), /cacheSize/);
    assert.throws(() => resolveConfig({ wrapAllProviders: 'yes' }), /wrapAllProviders/);
    assert.throws(() => resolveConfig({ innerProviders: [''] }), /innerProviders/);
});
