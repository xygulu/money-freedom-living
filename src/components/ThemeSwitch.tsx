'use client';

// 前台改造（70-2 E2）· 调性切换控件。
//
// 写入 document.documentElement.dataset.sceneTheme；无持久化——刷新回 plain。
// 这是产品层"先做默认"的克制（70-2 §8）：不接 cookie 不接服务器，
// 仅供演示三个调性的视觉效果。后续要做持久化再加 cookie 通路。

import { useEffect, useState } from 'react';
import styles from './ThemeSwitch.module.css';

type Theme = 'plain' | 'paper' | 'night';

export default function ThemeSwitch({
  labels,
}: {
  labels: { plain: string; paper: string; night: string };
}) {
  const [theme, setTheme] = useState<Theme>('plain');

  useEffect(() => {
    const current = (document.documentElement.dataset.sceneTheme as Theme) ?? 'plain';
    setTheme(current);
  }, []);

  function pick(next: Theme) {
    setTheme(next);
    document.documentElement.dataset.sceneTheme = next;
  }

  return (
    <div className={styles.seg} data-theme-switch role="radiogroup">
      {(['plain', 'paper', 'night'] as const).map((t) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={t === theme}
          onClick={() => pick(t)}
          className={`${styles.btn} ${t === theme ? styles.on : ''}`}
          data-theme-option={t}
        >
          {labels[t]}
        </button>
      ))}
    </div>
  );
}
