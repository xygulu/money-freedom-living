// SSE 响应小工具：把异步生成器包成 text/event-stream Response。
// 事件约定：data: {"session"|"delta"|"error"|"safety"|"wrap"|"providerSwitch": ...} / data: [DONE]
//   safety = 危机命中（值为类目），wrap = 会话到限温和收尾（delta 为收尾文案）
//   providerSwitch = 流中途切 provider 通知前端（已显示文本不回收；2026-09-16 多 provider 设计稿）
import { NextResponse } from 'next/server';

export interface SseProviderSwitch {
  from: string;
  to: string;
  reason: 'server_5xx' | 'stream_throw' | 'config_4xx' | 'timeout' | 'rate_limit';
  chunksYielded: number;
}

export interface SseEvent {
  delta?: string;
  session?: string;
  error?: string;
  safety?: string;
  wrap?: boolean;
  providerSwitch?: SseProviderSwitch;
}

export function sseResponse(events: AsyncGenerator<SseEvent>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of events) {
          if (event.providerSwitch) {
            // provider_switch 走自定义 SSE event type，前端 readSse 识别
            controller.enqueue(
              encoder.encode(`event: provider_switch\ndata: ${JSON.stringify(event.providerSwitch)}\n\n`)
            );
            continue;
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      } catch (error) {
        console.error('[sse] stream failed:', error);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: 'stream_failed' })}\n\n`));
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
    },
  });
}

export function jsonError(message: string, status: number, extra: Record<string, string> = {}) {
  return NextResponse.json({ error: message, ...extra }, { status, headers: { 'Cache-Control': 'no-store' } });
}
