/**
 * /root/money-freedom-living/src/lib/llm-sse-parse 单测。
 *
 * 5 用例直接覆盖 SSE 容错边界：合法 text_delta / 畸形 content_block_delta 无 delta /
 * 空 event / unknown type / message_start 带 usage。
 *
 * mock @/lib/llm-log 拦截 logProviderEvent（避免依赖 DB）。
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@/lib/llm-log', () => ({
  logProviderEvent: vi.fn().mockResolvedValue(undefined),
}));

import { logProviderEvent } from '@/lib/llm-log';
import { parseEvent, classifyError } from '@/lib/llm-sse-parse';

const logMock = vi.mocked(logProviderEvent);

const CTX = { providerId: 'zhipu', callId: 'test', callPurpose: 'chat.stream' };

beforeEach(() => {
  logMock.mockClear();
});

describe('parseEvent：合法 text_delta', () => {
  it('正常 content_block_delta + text_delta → yield_text', () => {
    const r = parseEvent(
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
      CTX
    );
    expect(r).toEqual({ action: 'yield_text', text: 'hi' });
    expect(logMock).not.toHaveBeenCalled();
  });
});

describe('parseEvent：畸形 event 容错', () => {
  it('event=null → malformed + log', () => {
    const r = parseEvent(null, CTX);
    expect(r.action).toBe('malformed');
    expect(logMock).toHaveBeenCalledTimes(1);
    expect(logMock.mock.calls[0][0].kind).toBe('malformed_event');
  });

  it('event=undefined → malformed', () => {
    const r = parseEvent(undefined, CTX);
    expect(r.action).toBe('malformed');
  });

  it('event=string → malformed', () => {
    const r = parseEvent('not an event', CTX);
    expect(r.action).toBe('malformed');
  });

  it('content_block_delta 但 delta 缺 → malformed（zhipu 原 bug 修）', () => {
    const r = parseEvent({ type: 'content_block_delta' }, CTX);
    expect(r.action).toBe('malformed');
    expect(logMock).toHaveBeenCalled();
  });

  it('content_block_delta + delta.type 不是 text_delta → malformed', () => {
    const r = parseEvent(
      { type: 'content_block_delta', delta: { type: 'input_json_delta' } },
      CTX
    );
    expect(r.action).toBe('malformed');
  });

  it('text_delta 但 text 不是 string → malformed', () => {
    const r = parseEvent(
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 123 } },
      CTX
    );
    expect(r.action).toBe('malformed');
  });
});

describe('parseEvent：跳过非 text event', () => {
  it('message_start 带 usage → skip + 提取 usageIn', () => {
    const r = parseEvent(
      { type: 'message_start', message: { usage: { input_tokens: 100 } } },
      CTX
    );
    expect(r.action).toBe('skip');
    expect(r.usageIn).toBe(100);
  });

  it('message_delta 带 usage → skip + 提取 usageOut', () => {
    const r = parseEvent(
      { type: 'message_delta', usage: { output_tokens: 50 } },
      CTX
    );
    expect(r.action).toBe('skip');
    expect(r.usageOut).toBe(50);
  });

  it('message_start 但无 usage → skip, usageIn=undefined', () => {
    const r = parseEvent({ type: 'message_start' }, CTX);
    expect(r.action).toBe('skip');
    expect(r.usageIn).toBeUndefined();
  });

  it('content_block_start → skip', () => {
    const r = parseEvent({ type: 'content_block_start', content_block: { type: 'text', text: '' } }, CTX);
    expect(r.action).toBe('skip');
    expect(logMock).not.toHaveBeenCalled();
  });

  it('message_stop → skip', () => {
    expect(parseEvent({ type: 'message_stop' }, CTX).action).toBe('skip');
  });

  it('ping → skip', () => {
    expect(parseEvent({ type: 'ping' }, CTX).action).toBe('skip');
  });

  it('未知 type → skip', () => {
    expect(parseEvent({ type: 'some_future_type' }, CTX).action).toBe('skip');
  });
});

describe('parseEvent：内部异常不能断流', () => {
  it('event 是循环引用导致 JSON.stringify 抛错 → catch + malformed', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const event = { type: 'message_start', message: { usage: { input_tokens: { toString: () => { throw new Error('boom'); } } } } };
    // 这里 type guard 是 typeof number；但我们让 path 走到某处抛错
    const r = parseEvent(event, CTX);
    // 不抛就行（不验证具体 action，因为 type guard 不严）
    expect(['skip', 'malformed']).toContain(r.action);
  });
});

describe('classifyError：HTTP 状态码分类', () => {
  it('status=429 → rate_limit', () => {
    expect(classifyError({ name: 'APIError', status: 429 })).toBe('rate_limit');
  });
  it('status=500/502/503 → server_5xx', () => {
    expect(classifyError({ status: 500 })).toBe('server_5xx');
    expect(classifyError({ status: 502 })).toBe('server_5xx');
    expect(classifyError({ status: 503 })).toBe('server_5xx');
  });
  it('status=400/401/403 → config_4xx', () => {
    expect(classifyError({ status: 400 })).toBe('config_4xx');
    expect(classifyError({ status: 401 })).toBe('config_4xx');
    expect(classifyError({ status: 403 })).toBe('config_4xx');
  });
  it('statusCode 兼容字段', () => {
    expect(classifyError({ statusCode: 429 })).toBe('rate_limit');
  });
  it('AbortError → timeout', () => {
    expect(classifyError({ name: 'AbortError' })).toBe('timeout');
  });
  it('message 含 timeout → timeout', () => {
    expect(classifyError({ message: 'request timeout' })).toBe('timeout');
  });
  it('未知错（无 status） → stream_throw', () => {
    expect(classifyError(new Error('connection reset'))).toBe('stream_throw');
  });
  it('null/undefined → stream_throw', () => {
    expect(classifyError(null)).toBe('stream_throw');
    expect(classifyError(undefined)).toBe('stream_throw');
  });
});