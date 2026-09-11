// SSE 响应小工具：把异步生成器包成 text/event-stream Response。
// 事件约定：data: {"session"|"delta"|"error"|"safety"|"wrap": ...} / data: [DONE]
//   safety = 危机命中（值为类目），wrap = 会话到限温和收尾（delta 为收尾文案）
import { NextResponse } from 'next/server';

export interface SseEvent {
  delta?: string;
  session?: string;
  error?: string;
  safety?: string;
  wrap?: boolean;
}

export function sseResponse(events: AsyncGenerator<SseEvent>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of events) {
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
