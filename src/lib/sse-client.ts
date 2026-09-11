// 客户端 SSE 读取：fetch POST → 按 \n\n 分帧 → data: JSON / data: [DONE]
export interface SseEvent {
  session?: string;
  delta?: string;
  error?: string;
  safety?: string;
  wrap?: boolean;
}

export async function readSse(response: Response, onEvent: (event: SseEvent) => void): Promise<void> {
  if (!response.body || !response.ok) throw new Error(`sse_http_${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        onEvent(JSON.parse(payload) as SseEvent);
      } catch {
        // 忽略坏帧
      }
    }
  }
}
