'use client';

// 前台改造（70-2 B1-B5）· 新一幕客户端视图。
//
// 五个段顺序渲染；只有「act」是交互的，submit 后切到 mirror 段。
// mirror 段出现时 act 段被折叠（节省屏高）；用户可点"改一下"回到 act。
//
// 数据来自父级（服务端已取好档案/签文/微行动），本组件只负责状态串联。
import { useState } from 'react';
import type { Dict } from '@/i18n/get-dict';
import type { DailyCard } from '@/lib/content';
import type { StageProgress } from '@/lib/stage';
import DailyCardNew from '@/components/DailyCardNew';
import ActCard from '@/components/ActCard';
import MirrorCard from '@/components/MirrorCard';
import PathBar from '@/components/PathBar';
import styles from './NewJourneyView.module.css';

interface Props {
  locale: string;
  dict: Dict;
  daily: DailyCard | null;
  exercise: string | null;
  progress: StageProgress;
  userKey: string;
  stage: number;
}

export default function NewJourneyView({ locale, dict, daily, exercise, progress, userKey, stage }: Props) {
  // 提交后的镜像状态（用户原话 + echo）；null = 未提交，仍在 act 段
  const [mirror, setMirror] = useState<{
    did: 'done' | 'partial' | 'missed';
    thought: string;
    firstLine: string;
    firstLineSkipped: boolean;
    receipt: string | null;
  } | null>(null);

  return (
    <div className={styles.view}>
      {/* 段 1: 一签 */}
      <section data-step="daily" className={styles.section}>
        <DailyCardNew locale={locale} dict={dict} daily={daily} />
      </section>

      {/* 段 2: 今天这一步（提交前显示）/ 段 3: mirror（提交后显示）*/}
      {mirror === null ? (
        <section data-step="act" className={styles.section}>
          <ActCard
            locale={locale}
            dict={dict}
            exercise={exercise}
            onSubmitted={(payload) => setMirror(payload)}
          />
        </section>
      ) : (
        <section data-step="done" className={styles.section}>
          <MirrorCard
            locale={locale}
            dict={dict}
            mirror={mirror}
            onEdit={() => setMirror(null)}
          />
        </section>
      )}

      {/* 段 4: 你的路（始终在底部，与提交状态无关）*/}
      <section data-step="path" className={styles.path}>
        <PathBar dict={dict} stage={stage} progress={progress} />
      </section>
    </div>
  );
}