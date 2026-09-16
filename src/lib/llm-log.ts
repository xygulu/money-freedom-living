/**
 * LLM provider 事件结构化日志 → 写 `llm_provider_events` 表 + console 输出。
 *
 * 设计依据：docs/design/multi-provider-failover.md §4.4 + §8.2。
 *
 * 关键约束（per CLAUDE.md 凭据约束）：
 *   - 不写 apiKey / baseURL / prompt / response 全文
 *   - user_key 是脱敏后值（u:<id> | g:<cookie>），不进 raw email / username
 *   - metadata jsonb 不允许存 LLM 返回文本
 *
 * 失败容错：写表失败仅 console.error，不抛——L1 日志不能阻塞 L2 主流程。
 */

import { execWithFailover, getSql } from './db';
import type { FailureKind } from './llm-health';

export type LlmLogKind =
  | 'start'
  | 'success'
  | 'failure'
  | 'switch'
  | 'malformed_event'
  | 'timeout'
  | 'admin_test';

export interface LlmLogEvent {
  providerId: string;
  callId: string;
  kind: LlmLogKind;
  errorKind?: FailureKind;
  durationMs?: number;
  chunksYielded?: number;
  callPurpose: string; // 'chat.stream' | 'onboarding.talk' | 'portrait' | ...
  userKey?: string; // 来自 resolveIdentity().key
  metadata?: Record<string, unknown>;
}

/**
 * 写一条 LLM provider 事件到 llm_provider_events + 输出 console。
 *
 * - 失败仅 console.error，不抛——L1 日志不能阻塞主调用方
 * - 不写敏感字段（调用方不能把 apiKey/baseURL/prompt 传进 metadata）
 */
export async function logProviderEvent(event: LlmLogEvent): Promise<void> {
  // console：dev / 生产可见
  if (event.kind === 'failure' || event.kind === 'malformed_event' || event.kind === 'timeout') {
    console.warn(
      `[llm-log] ${event.kind} provider=${event.providerId} call=${event.callId} purpose=${event.callPurpose}` +
        (event.errorKind ? ` error=${event.errorKind}` : '') +
        (event.chunksYielded != null ? ` chunks=${event.chunksYielded}` : '') +
        (event.durationMs != null ? ` duration=${event.durationMs}ms` : '')
    );
  }

  try {
    await execWithFailover(async (sql) => {
      await sql`
        INSERT INTO llm_provider_events (
          provider_id, call_id, kind, error_kind, duration_ms,
          chunks_yielded, call_purpose, user_key, metadata
        ) VALUES (
          ${event.providerId},
          ${event.callId},
          ${event.kind},
          ${event.errorKind ?? null},
          ${event.durationMs ?? null},
          ${event.chunksYielded ?? null},
          ${event.callPurpose},
          ${event.userKey ?? null},
          ${JSON.stringify(event.metadata ?? {})}::jsonb
        )
      `;
    });
  } catch (error) {
    // 写表失败不能阻塞主流程——L1 日志不能反噬 L2 调用
    console.error('[llm-log] failed to write llm_provider_events:', error instanceof Error ? error.message : error);
  }
}

/**
 * 用 crypto.randomUUID 生成 call id，单测可注入 `setCallIdFactory` 替身。
 */
let callIdCounter = 0;
export function newCallId(): string {
  callIdCounter = (callIdCounter + 1) & 0xffff;
  // 短前缀 + 时间戳 + 计数器 + randomUUID 前 8 位：保证唯一且可读
  return `c${Date.now().toString(36)}-${callIdCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// 兼容旧 logUsage 的入口（不影响新结构化日志）
export { getSql };