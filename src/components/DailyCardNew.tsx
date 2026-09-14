'use client';

// 前台改造（70-2 B1）· 今日一签卡片（新版一幕专用）。
//
// 服务端已取好 daily（pickDaily）+ 写入 daily_seen，本组件纯渲染。
// 整张大字（clamp 19-25）+ 下方一行 reflection（想想：…）。
import type { Dict } from '@/i18n/get-dict';
import type { DailyCard } from '@/lib/content';
import styles from './DailyCardNew.module.css';

interface Props {
  locale: string;
  dict: Dict;
  daily: DailyCard | null;
}

export default function DailyCardNew({ dict, daily }: Props) {
  const t = dict.newJourney;
  if (!daily) {
    return (
      <div className={styles.empty}>
        <p className={styles.eyebrow}>{t.dailyEyebrow}</p>
        <p className={styles.emptyHint}>今天没有签——打开就够。</p>
      </div>
    );
  }
  return (
    <article className={styles.card}>
      <p className={styles.eyebrow}>{t.dailyEyebrow}</p>
      <p className={styles.text} data-daily-text="">{daily.text}</p>
      {daily.reflection ? (
        <p className={styles.reflect}>
          <span className={styles.reflectLabel}>想想：</span>
          {daily.reflection}
        </p>
      ) : null}
    </article>
  );
}