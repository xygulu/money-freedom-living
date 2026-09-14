'use client';

// 前台改造（70-2 A2）· 设置段落里的版本切换控件。
//
// 用户在 /archive → 设置 里两选一切换：写入 cookie mfl_ui_version，
// 再 router.refresh() 让服务端组件重渲染。
// 选中的态走 ink 填底 + 极简字体，对齐 scene-tokens.css。

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import styles from './VersionSwitch.module.css';

type UiVersion = 'new' | 'classic';

export default function VersionSwitch({
  locale,
  current,
  labels,
}: {
  locale: string;
  current: UiVersion;
  labels: { new: string; classic: string };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function pick(version: UiVersion) {
    if (version === current || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/ui-version', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      if (!res.ok) throw new Error(String(res.status));
      router.refresh();
      // ui_version 改后服务端按版本分流，需要重定向到新页面让用户看到效果
      const target = version === 'classic' ? `/${locale}/journey` : `/${locale}/journey-new`;
      router.push(target);
    } catch (e) {
      setErr('failed');
      setBusy(false);
    }
  }

  return (
    <div className={styles.seg} data-version-switch role="radiogroup">
      {(['new', 'classic'] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={v === current}
          disabled={busy}
          onClick={() => pick(v)}
          className={`${styles.btn} ${v === current ? styles.on : ''}`}
          data-version={v}
        >
          {labels[v]}
        </button>
      ))}
      {err && <span className={styles.err}>×</span>}
    </div>
  );
}
