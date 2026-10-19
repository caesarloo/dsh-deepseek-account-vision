/**
 * 图片来源读取：本地路径（经 `ctx.fs`，尊重会话工作目录与文件沙箱）或
 * http(s) URL（进程内 fetch），随后交给 `ctx.attachments.saveImage()` 归一化
 * 成持久图片附件引用。
 *
 * 归一化（尺寸/像素/字节上限、16-bit PNG 转 8-bit、格式校验）由附件服务完成，
 * 本插件不引入 sharp 之类的图像库。
 *
 * @module dsh-deepseek-vision/image-source
 */
import { basename } from 'node:path';

/** 扩展名 → 媒体类型。 */
export const IMAGE_EXTENSIONS = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
};

/** 部署默认支持的图片媒体类型（附件服务真正支持的范围）。 */
export const DEFAULT_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const DEFAULT_BYTE_CAP = 20 * 1024 * 1024;

function matchesBytes(data, offset, signature) {
    if (data.byteLength < offset + signature.length) return false;
    for (let index = 0; index < signature.length; index += 1) {
        if (data[offset + index] !== signature[index]) return false;
    }
    return true;
}

function matchesAscii(data, offset, text) {
    if (data.byteLength < offset + text.length) return false;
    for (let index = 0; index < text.length; index += 1) {
        if (data[offset + index] !== text.charCodeAt(index)) return false;
    }
    return true;
}

/**
 * 按文件签名识别图片媒体类型（PNG/JPEG/WebP/GIF）。
 * @param {Uint8Array} data 图片字节。
 * @returns {string | undefined}
 */
export function sniffImageMediaType(data) {
    if (matchesBytes(data, 0, PNG_SIGNATURE)) return 'image/png';
    if (matchesBytes(data, 0, JPEG_SIGNATURE)) return 'image/jpeg';
    if (matchesAscii(data, 0, 'GIF87a') || matchesAscii(data, 0, 'GIF89a')) return 'image/gif';
    if (matchesAscii(data, 0, 'RIFF') && matchesAscii(data, 8, 'WEBP')) return 'image/webp';
    return undefined;
}

/**
 * 按扩展名声明媒体类型。
 * @param {string} filePath 文件路径。
 * @returns {string | undefined}
 */
export function imageMediaTypeForPath(filePath) {
    const dot = filePath.lastIndexOf('.');
    if (dot < 0) return undefined;
    return IMAGE_EXTENSIONS[filePath.slice(dot).toLowerCase()];
}

/** 从附件服务读取部署的图片限制，缺省时给出安全默认值。 */
export function imageLimitsOf(attachments) {
    const limits = attachments?.imageLimits ?? {};
    const mediaTypes = Array.isArray(limits.mediaTypes) && limits.mediaTypes.length > 0
        ? limits.mediaTypes
        : DEFAULT_MEDIA_TYPES;
    const maxImageBytes = Number.isFinite(limits.maxImageBytes) ? limits.maxImageBytes : DEFAULT_BYTE_CAP;
    const maxMessageImageBytes = Number.isFinite(limits.maxMessageImageBytes) ? limits.maxMessageImageBytes : maxImageBytes;
    return {
        mediaTypes,
        maxImageBytes,
        maxMessageImageBytes,
        byteCap: Math.min(maxImageBytes, maxMessageImageBytes),
    };
}

function assertMediaTypeSupported(limits, mediaType, source) {
    if (!limits.mediaTypes.includes(mediaType)) {
        throw new Error(`不支持该图片格式: "${source}" 是 ${mediaType}；本部署只接受 ${limits.mediaTypes.join(' / ')}`);
    }
}

/**
 * 读取本地图片字节。
 * @param {object} ctx 插件上下文（需要 `fs`、`workingDirectory` 服务）。
 * @param {object} exec 工具执行上下文（提供 `agent` 与 `signal`）。
 * @param {string} requestedPath 模型给出的图片路径。
 * @param {object} limits `imageLimitsOf()` 的结果。
 * @returns {Promise<{data: Uint8Array, mediaType: string, name: string, source: string}>}
 */
export async function readImageFromPath(ctx, exec, requestedPath, limits) {
    const cwd = exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal);
    const target = await ctx.fs.resolve(requestedPath, {
        ...(cwd === undefined ? {} : { cwd }),
        signal: exec.signal,
    });
    const info = await ctx.fs.stat(target, exec.signal);
    if (info === undefined) throw new Error(`图片文件不存在: ${target.displayPath}`);
    if (info.type !== 'file') throw new Error(`不是普通文件: ${target.displayPath}`);

    const declared = imageMediaTypeForPath(target.displayPath);
    if (declared === undefined && /\.[^./\\]+$/.test(target.displayPath)) {
        throw new Error(`不支持的图片扩展名: ${target.displayPath}（支持 PNG/JPEG/WebP/GIF）`);
    }
    const data = await ctx.fs.readBytes(target, exec.signal, limits.byteCap);
    const mediaType = declared ?? sniffImageMediaType(data);
    if (mediaType === undefined) throw new Error(`无法识别图片格式: ${target.displayPath}（支持 PNG/JPEG/WebP/GIF）`);
    assertMediaTypeSupported(limits, mediaType, target.displayPath);
    return {
        data,
        mediaType,
        name: basename(target.displayPath),
        source: target.displayPath,
    };
}

function mediaTypeFromContentType(header) {
    if (typeof header !== 'string') return undefined;
    const value = header.split(';')[0].trim().toLowerCase();
    return DEFAULT_MEDIA_TYPES.includes(value) ? value : undefined;
}

/**
 * 下载 http(s) 图片字节。
 * @param {string} rawUrl 图片地址。
 * @param {object} options 选项。
 * @param {number} options.maxBytes 字节上限。
 * @param {number} options.timeoutMs 下载超时。
 * @param {AbortSignal} [options.signal] 调用方取消信号。
 * @returns {Promise<{data: Uint8Array, mediaType: string, name: string, source: string}>}
 */
export async function readImageFromUrl(rawUrl, { maxBytes, timeoutMs, signal }) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error(`无效的图片 URL: ${rawUrl}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`只支持 http(s) 图片 URL: ${rawUrl}`);
    }

    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal !== undefined) signals.push(signal);
    let response;
    try {
        response = await fetch(url, {
            signal: AbortSignal.any(signals),
            redirect: 'follow',
            headers: { accept: 'image/png,image/jpeg,image/webp,image/gif' },
        });
    } catch (error) {
        const name = error instanceof Error ? error.name : '';
        if (name === 'TimeoutError' || name === 'AbortError') throw new Error(`下载图片超时（${timeoutMs}ms）: ${rawUrl}`);
        throw new Error(`下载图片失败: ${rawUrl}（${error instanceof Error ? error.message : String(error)}）`);
    }
    if (!response.ok) throw new Error(`下载图片失败: ${rawUrl} 返回 HTTP ${response.status}`);

    const declaredLength = Number(response.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error(`图片太大: ${declaredLength} 字节，超过上限 ${maxBytes} 字节`);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > maxBytes) throw new Error(`图片太大: ${data.byteLength} 字节，超过上限 ${maxBytes} 字节`);

    const mediaType = sniffImageMediaType(data) ?? mediaTypeFromContentType(response.headers.get('content-type'));
    if (mediaType === undefined) throw new Error(`URL 内容不是支持的图片格式（PNG/JPEG/WebP/GIF）: ${rawUrl}`);
    const leaf = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? 'remote-image');
    return {
        data,
        mediaType,
        name: leaf === '' ? 'remote-image' : leaf,
        source: url.href,
    };
}

/**
 * 把图片字节保存为持久附件。附件服务的准入/归一化错误映射为可读提示。
 * @param {object} attachments 附件服务。
 * @param {{data: Uint8Array, mediaType: string, name?: string}} image 图片。
 * @returns {Promise<object>} 持久图片引用（`ImageAttachmentRef`）。
 */
export async function saveImageAttachment(attachments, { data, mediaType, name }) {
    try {
        return await attachments.saveImage({
            data,
            mediaType,
            ...(name === undefined || name === '' ? {} : { name }),
        });
    } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : '';
        const reason = error instanceof Error ? error.message : String(error);
        if (code === 'IMAGE_TOO_LARGE') throw new Error(`图片字节超出附件存储上限，请压缩或缩小后重试（${reason}）`);
        if (code === 'IMAGE_TOO_MANY_PIXELS') throw new Error(`图片像素数超出上限，请缩小后重试（${reason}）`);
        if (code === 'IMAGE_DIMENSION_TOO_LARGE') throw new Error(`图片边长超出上限，请缩小后重试（${reason}）`);
        if (code === 'INVALID_IMAGE') throw new Error(`图片字节无法解码（可能已损坏，或不是 PNG/JPEG/WebP/GIF）: ${reason}`);
        if (code === 'IMAGE_TYPE_MISMATCH') throw new Error(`图片扩展名与真实格式不一致，请改成正确扩展名后重试（${reason}）`);
        throw new Error(`保存图片附件失败: ${reason}`);
    }
}
