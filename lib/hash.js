/**
 * 用一行 `sha256` 摘要给图片/提示词做内容键（缓存与并发合并都靠它）。
 * @module dsh-deepseek-account-vision/hash
 */
import { createHash } from 'node:crypto';

/**
 * @param {Uint8Array | string} data 待摘要的字节或字符串。
 * @returns {string} 32 字节十六进制摘要。
 */
export function sha256Hex(data) {
    return createHash('sha256').update(data).digest('hex');
}
