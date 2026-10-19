/**
 * 进程内缓存与同键并发合并。
 *
 * - `VisionCache`：有上限的 LRU（Map 插入序实现），按图片内容哈希去重；
 *   从不落盘。
 * - `SingleFlight`：同一张图片在同一时刻只发起一次识图请求，其余调用等待
 *   同一个 Promise（一轮回复里同一张图出现多次时不会重复计费）。
 *
 * @module dsh-deepseek-account-vision/cache
 */

/** 有上限的 LRU 缓存。`limit <= 0` 时退化为不缓存。 */
export class VisionCache {
    /** @param {number} limit 最大条目数。 */
    constructor(limit) {
        this.limit = Number.isInteger(limit) && limit > 0 ? limit : 0;
        /** @type {Map<string, unknown>} */
        this.entries = new Map();
    }

    /** @param {string} key 缓存键。 @returns {unknown} 命中值或 undefined。 */
    get(key) {
        const value = this.entries.get(key);
        if (value === undefined) return undefined;
        // 命中后移到队尾，维持 LRU 顺序。
        this.entries.delete(key);
        this.entries.set(key, value);
        return value;
    }

    /** @param {string} key 缓存键。 @param {unknown} value 缓存值。 */
    set(key, value) {
        if (this.limit <= 0) return;
        if (this.entries.has(key)) this.entries.delete(key);
        else if (this.entries.size >= this.limit) {
            const oldest = this.entries.keys().next();
            if (oldest.done !== true) this.entries.delete(oldest.value);
        }
        this.entries.set(key, value);
    }

    /** @param {string} key 缓存键。 */
    delete(key) {
        this.entries.delete(key);
    }

    /** 当前条目数。 */
    get size() {
        return this.entries.size;
    }
}

/** 同键并发合并：相同 key 的并发调用共享同一个 Promise。 */
export class SingleFlight {
    constructor() {
        /** @type {Map<string, Promise<unknown>>} */
        this.inflight = new Map();
    }

    /**
     * @template T
     * @param {string} key 合并键。
     * @param {() => Promise<T>} task 真正执行的任务。
     * @returns {Promise<T>}
     */
    run(key, task) {
        const existing = this.inflight.get(key);
        if (existing !== undefined) return /** @type {Promise<T>} */ (existing);
        const promise = Promise.resolve()
            .then(task)
            .finally(() => {
                this.inflight.delete(key);
            });
        this.inflight.set(key, promise);
        return promise;
    }
}
