// 客户端 SSE 读取：fetch POST → 按 \n\n 分帧 → data: JSON / data: [DONE]
// 2026-09-16 多 provider 升级：识别 `event: provider_switch\ndata: ...` 自定义事件
// （见设计稿 §8.3）；前端拿到 SseEvent.providerSwitch 后做灰色小字提示，不清空已显示文本。
export interface SseEvent {
  session?: string;
  delta?: string;
  error?: string;
  safety?: string;
  wrap?: boolean;
  /** 流中途 provider 切换（已显示文本不回收，仅提示） */
  providerSwitch?: { from: string; to: string; reason: string; chunksYielded: number };
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
      // 多行 frame：`event: provider_switch\ndata: {...}`
      const lines = frame.split('\n');
      let customEvent: string | null = null;
      let dataPayload: string | null = null;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('event:')) {
          customEvent = trimmed.slice(6).trim();
        } else if (trimmed.startsWith('data:')) {
          dataPayload = trimmed.slice(5).trim();
        }
      }
      if (dataPayload == null) continue;
      if (dataPayload === '[DONE]') return;
      let parsed: SseEvent | null = null;
      try {
        parsed = JSON.parse(dataPayload) as SseEvent;
      } catch {
        continue; // 忽略坏帧
      }
      if (customEvent === 'provider_switch' && parsed && typeof parsed === 'object') {
        // provider_switch 走 SseEvent.providerSwitch（保留 SseEvent 其它字段兜底）
        onEvent({ ...parsed, providerSwitch: parsed.providerSwitch ?? (parsed as any) });
        continue;
      }
      onEvent(parsed);
    }
  }
}