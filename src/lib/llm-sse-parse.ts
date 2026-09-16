/**
 * LLM SSE event 解析（容错版本）。从 src/lib/llm.ts 抽出以便单测。
 *
 * 关键 bug 修复（per 设计稿 §3.4 + 用户 2026-09-15 反馈）：
 *   原 llm.ts:180 'event.delta.type === \"text_delta\"' 在 zhipu 推畸形 event
 *   （event.delta === undefined）时抛 TypeError。
 *   本函数：单 event try/catch 不冒泡；畸形 event 当 malformed_event 跳过，
 *   正常 event 走原路径；返回 discriminated union 让 rawLlmStream 选择 yield。
 *
 * 设计依据：docs/design/multi-provider-failover.md §3.4。
 */

import { logProviderEvent, type LlmLogKind } from './llm-log';

export interface ParseResult {
  /** 'yield_text' = 流应该 yield 这段 text；'skip' = 跳过本 event；'malformed' = 记录日志并跳过 */
  action: 'yield_text' | 'skip' | 'malformed';
  text?: string;
  /** 当 action='malformed'，给 log 的 kind（'malformed_event'） */
  logKind?: LlmLogKind;
  /** 短文本描述（不写 prompt / response 全文） */
  detail?: string;
  /** usage（message_start/message_delta 提取） */
  usageIn?: number;
  usageOut?: number;
}

/**
 * 把 SDK 推的单个 event 转成 ParseResult。
 *
 * - event 不是合法 object → malformed（logProviderEvent 记 malformed_event + skip）
 * - event.type === 'message_start' → 取 input_tokens usage（skip）
 * - event.type === 'message_delta' → 取 output_tokens usage（skip）
 * - event.type === 'content_block_delta' 且 delta.type === 'text_delta' → yield_text
 * - event.type === 'content_block_delta' 但 delta 缺 / type 不是 text_delta → malformed（zhipu 原 bug 修）
 * - 其它已知 type（content_block_start/stop/message_stop/ping） → skip
 * - 任何内部 catch → malformed（单 event 不影响外层流）
 */
export function parseEvent(
  event: unknown,
  logContext: { providerId: string; callId: string; callPurpose: string; userKey?: string }
): ParseResult {
  try {
    if (!event || typeof event !== 'object') {
      logProviderEvent({
        providerId: logContext.providerId,
        callId: logContext.callId,
        kind: 'malformed_event',
        callPurpose: logContext.callPurpose,
        userKey: logContext.userKey,
        metadata: { raw: String(event).slice(0, 200) },
      });
      return { action: 'malformed', detail: 'event_not_object' };
    }

    const e = event as { type?: unknown; delta?: { type?: unknown; text?: unknown }; message?: { usage?: { input_tokens?: unknown } }; usage?: { output_tokens?: unknown } };

    if (e.type === 'message_start') {
      const input = typeof e.message?.usage?.input_tokens === 'number' ? e.message.usage.input_tokens : undefined;
      return { action: 'skip', usageIn: input };
    }

    if (e.type === 'message_delta' && e.usage) {
      const output = typeof e.usage.output_tokens === 'number' ? e.usage.output_tokens : undefined;
      return { action: 'skip', usageOut: output };
    }

    if (e.type === 'content_block_delta') {
      if (!e.delta || e.delta.type !== 'text_delta' || typeof e.delta.text !== 'string') {
        logProviderEvent({
          providerId: logContext.providerId,
          callId: logContext.callId,
          kind: 'malformed_event',
          callPurpose: logContext.callPurpose,
          userKey: logContext.userKey,
          metadata: { deltaType: typeof e.delta?.type === 'string' ? e.delta.type : null },
        });
        return { action: 'malformed', detail: 'delta_no_text' };
      }
      return { action: 'yield_text', text: e.delta.text };
    }

    // 已知但不需要处理的 type（content_block_start/stop/message_stop/ping/...）
    return { action: 'skip' };
  } catch (err) {
    // 单 event 处理抛错不能断流；log 后跳过
    logProviderEvent({
      providerId: logContext.providerId,
      callId: logContext.callId,
      kind: 'malformed_event',
      callPurpose: logContext.callPurpose,
      userKey: logContext.userKey,
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    return { action: 'malformed', detail: 'event_handler_throw' };
  }
}

/**
 * 从 SDKError 形态判定 FailureKind。
 * 上游 try/catch 捕获后调用，根据 kind 调 health.recordFailure / recordRateLimit。
 *
 * 决策依据：设计稿 §3.5。
 * - 429 → rate_limit（短冷却 30s）
 * - 5xx → server_5xx（硬故障）
 * - 4xx（除 429）→ config_4xx（立即封顶 5min）
 * - 流中途抛错（非 HTTP）→ stream_throw
 * - AbortError / timeout → timeout
 */
export function classifyError(err: unknown): 'server_5xx' | 'stream_throw' | 'config_4xx' | 'timeout' | 'rate_limit' {
  if (!err) return 'stream_throw';
  // Anthropic SDK 抛 APIError（status / name）
  const anyErr = err as { name?: string; status?: number; statusCode?: number; code?: string; message?: string };
  const status = anyErr.status ?? anyErr.statusCode;
  const name = anyErr.name ?? '';

  if (name === 'AbortError' || /timeout|abort/i.test(anyErr.message ?? '')) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (typeof status === 'number' && status >= 500) return 'server_5xx';
  if (typeof status === 'number' && status >= 400) return 'config_4xx';
  return 'stream_throw';
}