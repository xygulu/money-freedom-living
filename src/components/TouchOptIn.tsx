'use client';

// 节点来信的开关（M11-E，docs/05 §9.3 opt-in + 退订）。
//
// 放在「我的」里，是因为退订必须是可逆的：邮件里那条链接一点就关，关完总得有个地方
// 能再打开，否则「随时可以重新打开」就是句空话。
//
// 开关的文案只说状态（开着 / 关着），不说「你将收到 N 封」——这不是订阅套餐。
import { useState } from 'react';
import type { Dict } from '@/i18n/get-dict';

export default function TouchOptIn({ dict, initialOptIn }: { dict: Dict; initialOptIn: boolean }) {
  const t = dict.touch;
  const [optIn, setOptIn] = useState(initialOptIn);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    const next = !optIn;
    try {
      const res = await fetch('/api/touch/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optIn: next }),
      });
      if (res.ok) setOptIn(next);
    } catch {
      // 网络不通就维持原状：开关的显示与服务端状态不一致，比静默改掉更糟
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-touch-setting={optIn ? 'on' : 'off'} className="mt-10 border-t border-line pt-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-base">{t.settingLabel}</span>
          <span className="text-sm leading-relaxed text-ink-soft">{optIn ? t.settingOn : t.settingOff}</span>
        </div>
        <button
          type="button"
          onClick={toggle}
          disabled={busy}
          data-touch-toggle
          className="shrink-0 rounded-full border border-line px-4 py-1.5 text-sm text-ink-soft hover:border-accent hover:text-accent disabled:opacity-40"
        >
          {optIn ? t.toggleOff : t.toggleOn}
        </button>
      </div>
    </section>
  );
}
