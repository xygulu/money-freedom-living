'use client';

// 发布按钮（V0.2 C3）：调 /api/admin/publish → 子进程重编译内容 + 进程内热替换。
// 成功显示 build 摘要；失败把校验错误逐行亮出来——后台页就是发布闸的报告台。
import { useState } from 'react';

export default function PublishButton() {
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<{ ok: boolean; text: string } | null>(null);

  async function publish() {
    setBusy(true);
    setLog(null);
    try {
      const res = await fetch('/api/admin/publish', { method: 'POST' });
      const data = (await res.json()) as { ok: boolean; log?: string };
      setLog({ ok: Boolean(data.ok), text: data.log ?? (data.ok ? '' : '未知错误') });
    } catch {
      setLog({ ok: false, text: '网络错误，没发出去' });
    }
    setBusy(false);
  }

  return (
    <div data-admin-publish>
      <button
        type="button"
        onClick={() => void publish()}
        disabled={busy}
        className="border border-ink px-5 py-2 text-sm transition-colors hover:bg-ink hover:text-paper disabled:opacity-50"
      >
        {busy ? '正在编译内容……' : '重新编译并发布'}
      </button>
      {log && (
        <pre
          data-publish-log={log.ok ? 'ok' : 'failed'}
          className={`mt-3 max-h-64 overflow-auto border px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap ${
            log.ok ? 'border-line text-ink-soft' : 'border-red-300 text-red-700'
          }`}
        >
          {log.text}
        </pre>
      )}
    </div>
  );
}
