/**
 * LLM provider 健康状态机（circuit breaker lite）。
 *
 * 设计依据：docs/design/multi-provider-failover.md §3.1 L1 层 + §3.3 规则。
 *
 * 核心行为：
 *   - 连续失败 n 次（FAILURE_THRESHOLD，默认 3）→ cooldown
 *   - cooldown 时长按 COOLDOWN_STEPS_MS 指数退避，封顶 COOLDOWN_MAX_MS
 *   - 429（rate_limit）不计 consecutiveFailures，但单独触发 RATE_LIMIT_COOLDOWN_MS 短冷却
 *   - cooldown 结束 → provider 重新可用；一次成功 → consecutiveFailures = 0
 *
 * 跨进程不共享（用户 2026-09-16 决定 4：不上 Redis）—— 多实例各自独立 Map。
 * admin 健康面板读 `snapshot()` 拿当前状态（实时）；历史曲线查 `llm_provider_events` 表。
 */

import {
  COOLDOWN_MAX_MS,
  COOLDOWN_STEPS_MS,
  FAILURE_THRESHOLD,
  RATE_LIMIT_COOLDOWN_MS,
} from './llm-config';

/** 失败原因分类（设计稿 §3.5） */
export type FailureKind = 'server_5xx' | 'stream_throw' | 'config_4xx' | 'timeout' | 'rate_limit';

interface HealthState {
  consecutiveFailures: number;
  cooldownUntil: number; // epoch ms；0 = 未冷却
  lastErrorKind: FailureKind | null;
  lastErrorAt: number | null;
}

export interface HealthSnapshot {
  id: string;
  consecutiveFailures: number;
  cooldownUntil: number;
  lastErrorKind: FailureKind | null;
}

export class ProviderHealth {
  private states = new Map<string, HealthState>();

  /**
   * provider 是否在可用状态（不在 cooldown 内）。
   * `now` 默认 `Date.now()`，单测可注入固定值验证时间窗口。
   */
  isEnabled(id: string, now: number = Date.now()): boolean {
    const s = this.states.get(id);
    if (!s) return true; // 没见过 = 默认可用
    return s.cooldownUntil <= now;
  }

  /** 一次成功 → 重置 consecutiveFailures，cooldown 清零 */
  recordSuccess(id: string): void {
    this.states.set(id, {
      consecutiveFailures: 0,
      cooldownUntil: 0,
      lastErrorKind: null,
      lastErrorAt: null,
    });
  }

  /**
   * 硬失败一次：consecutiveFailures 累加；超过阈值进入 cooldown。
   * 指数退避：连续失败 n 次后 cooldown = COOLDOWN_STEPS_MS[min(n, steps-1)]，封顶 MAX。
   *
   * 冷却期内的再次失败 → 取当前冷却结束时间 vs 新计算的最大值（取长者），
   * 不从 now 重置——避免在 1 秒内连发 100 次失败就把"5 分钟冷却"刷成"从这次算起 10 秒"。
   */
  recordFailure(id: string, kind: FailureKind, now: number = Date.now()): void {
    const prev = this.states.get(id);
    const failures = (prev?.consecutiveFailures ?? 0) + 1;

    // 4xx（除 429）通常是配置错（key / baseURL 错），跳过 cooldown 阈值立刻封 5 分钟。
    // 避免反复重试已知死的配置。
    const isConfigError = kind === 'config_4xx';
    const stepIndex = isConfigError
      ? COOLDOWN_STEPS_MS.length - 1 // 直接封顶
      : Math.min(failures - 1, COOLDOWN_STEPS_MS.length - 1);
    const cooldownMs = isConfigError
      ? COOLDOWN_MAX_MS
      : Math.min(COOLDOWN_STEPS_MS[stepIndex], COOLDOWN_MAX_MS);

    // 仅在 failures >= FAILURE_THRESHOLD 时进入 cooldown（指数退避）；否则只是计数。
    const shouldCooldown = isConfigError || failures >= FAILURE_THRESHOLD;
    if (!shouldCooldown) {
      this.states.set(id, {
        consecutiveFailures: failures,
        cooldownUntil: prev?.cooldownUntil ?? 0,
        lastErrorKind: kind,
        lastErrorAt: now,
      });
      return;
    }

    // 取 max(prev.cooldownUntil, now + cooldownMs)：冷却期内再失败，只延长不缩短。
    const candidate = now + cooldownMs;
    const cooldownUntil = Math.max(prev?.cooldownUntil ?? 0, candidate);

    this.states.set(id, {
      consecutiveFailures: failures,
      cooldownUntil,
      lastErrorKind: kind,
      lastErrorAt: now,
    });
  }

  /**
   * 429 限流：不算 consecutiveFailures（限流不算硬故障），触发单次短冷却。
   * cooldown 期间该 provider 不进 retry 列表，但其他 provider 可正常服务。
   */
  recordRateLimit(id: string, now: number = Date.now()): void {
    const prev = this.states.get(id);
    // 已在 cooldown 里就保持原状（不被 429 覆盖）
    if (prev && prev.cooldownUntil > now) return;
    this.states.set(id, {
      consecutiveFailures: prev?.consecutiveFailures ?? 0,
      cooldownUntil: now + RATE_LIMIT_COOLDOWN_MS,
      lastErrorKind: 'rate_limit',
      lastErrorAt: now,
    });
  }

  /** 诊断快照（admin 后台读），不含时间敏感数据。 */
  snapshot(): HealthSnapshot[] {
    return Array.from(this.states.entries()).map(([id, s]) => ({
      id,
      consecutiveFailures: s.consecutiveFailures,
      cooldownUntil: s.cooldownUntil,
      lastErrorKind: s.lastErrorKind,
    }));
  }

  /** 单测 / admin 用：清空所有状态。 */
  reset(): void {
    this.states.clear();
  }
}

/**
 * 模块单例：进程内一个 map，所有 LLM 调用共享。
 * 测试可通过 `setProviderHealth(new ProviderHealth())` 替换。
 */
let globalHealth: ProviderHealth = new ProviderHealth();

export function getProviderHealth(): ProviderHealth {
  return globalHealth;
}

export function setProviderHealth(h: ProviderHealth): void {
  globalHealth = h;
}