/**
 * LLM 多 provider failover 可配常量（per 用户 2026-09-16 决定：封顶 5 分钟但可配）。
 *
 * 设计依据：docs/design/multi-provider-failover.md §8.1。
 * admin 后台（设计稿 2）会暴露 COOLDOWN_MAX_MS 的 toggle——这里只是常量出口。
 */

/** 连续失败 cooldown 封顶：默认 5 分钟。zhipu 故障一般 1-2 分钟自愈，5 分钟留 buffer。 */
export const COOLDOWN_MAX_MS = 300_000;

/**
 * 失败次数 → cooldown 时长（指数退避，封顶 COOLDOWN_MAX_MS）。
 * 第 1 次失败后 10s 重试；第 2 次 30s；第 3 次 60s；之后 300s（封顶）。
 */
export const COOLDOWN_STEPS_MS: readonly number[] = [10_000, 30_000, 60_000, 300_000];

/**
 * 429（限流）单次 cooldown：不算 consecutiveFailures，但触发 30s 短冷却。
 * 让限流期间另一个 provider 空闲被利用，避免 429 期间硬塞每个请求。
 */
export const RATE_LIMIT_COOLDOWN_MS = 30_000;

/** 连续失败 → 进入 cooldown 的门槛（默认 3 次连续失败 = cooldown）。 */
export const FAILURE_THRESHOLD = 3;

/** 流超时（沿用原 DEFAULT_TIMEOUT_MS，迁移到这里便于 admin 调）。 */
export const STREAM_TIMEOUT_MS = 45_000;