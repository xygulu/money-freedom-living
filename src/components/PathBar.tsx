'use client';

// 前台改造（70-2 B4）· 你的路（PathBar）：14 格 + 4 阶段节点。
//
// 与 JourneyProgressBar 共享同一份"灯表"真值（confirmed 评估），但渲染更轻：
// - 没有 zone / zone-state / lamp-count 等三层数据契约
// - 用 14 个小圆点串成一行（已走=实心/当前=呼吸/未到=虚线）
// - 4 个阶段节点（小圆 + 名字），点击展开"评估"路径（M11 阶段评估保留）
//
// 之所以重写一遍而不是复用 JourneyProgressBar：经典版路径有 25+ 个 data-* 锚点
// （smoke-m5/m9/m10/m11），新一幕要清爽——自己的实现只暴露 data-step / data-zone。
import Link from 'next/link';
import type { Dict } from '@/i18n/get-dict';
import type { StageProgress } from '@/lib/stage';
import styles from './PathBar.module.css';

interface Props {
  dict: Dict;
  stage: number;
  progress: StageProgress;
}

const TOTAL_DOTS = 14;

export default function PathBar({ dict, stage, progress }: Props) {
  const t = dict.newJourney;
  const stageNames = t.stageNames ?? ['看见', '松动', '练习', '活法'];

  // 把"已走的灯数"按当前阶段的进度比例映射到 14 格里的若干格
  // 已完成阶段整段填充；当前阶段按 litCount/totalChecks
  // 没有评估的（litCount=0）按 0 计
  const litPerStage = computeLitPerStage(stage, progress);

  const dots: ('lit' | 'breathing' | 'empty')[] = [];
  for (let s = 1 as 1 | 2 | 3 | 4; s <= 4; s = ((s as number) + 1) as 1 | 2 | 3 | 4) {
    const lit = litPerStage[s] ?? 0;
    const totalInStage = s === stage ? Math.max(1, progress.checks.length || 4) : 4;
    const ratio = Math.max(0, Math.min(1, lit / totalInStage));
    const dotsInStage = s === stage ? 4 : 3;
    const litDots = Math.floor(ratio * dotsInStage);
    for (let i = 0; i < litDots; i++) dots.push('lit');
    if (s === stage) {
      for (let i = litDots; i < dotsInStage; i++) dots.push('breathing');
    }
  }
  // 补齐到 14
  while (dots.length < TOTAL_DOTS) dots.push('empty');

  return (
    <section className={styles.bar} data-step="path">
      <p className={styles.eyebrow}>{t.pathEyebrow}</p>
      <div className={styles.row} role="list" aria-label="阶段进度">
        {dots.slice(0, TOTAL_DOTS).map((kind, i) => (
          <span
            key={i}
            role="listitem"
            aria-label={kind === 'lit' ? '已走' : kind === 'breathing' ? '当前' : '未到'}
            className={`${styles.dot} ${styles[`dot_${kind}`]}`}
          />
        ))}
      </div>
      <div className={styles.stages} role="tablist">
        {[1, 2, 3, 4].map((s) => (
          <Link
            key={s}
            href={`/${dictStageLocale(dict)}/journey/changes?stage=${s}`}
            role="tab"
            aria-current={s === stage ? 'true' : undefined}
            className={`${styles.stage} ${s === stage ? styles.stageOn : ''}`}
          >
            <span className={styles.stageDot} aria-hidden="true" />
            <span className={styles.stageName}>{stageNames[s - 1] ?? `阶段 ${s}`}</span>
          </Link>
        ))}
      </div>
      <p className={styles.hint}>{t.pathHint}</p>
    </section>
  );
}

interface LitPerStageResult {
  1: number;
  2: number;
  3: number;
  4: number;
}

function computeLitPerStage(currentStage: number, progress: StageProgress): Record<1 | 2 | 3 | 4, number> {
  // 简化：之前阶段 4 灯全亮（合"走过"），当前阶段 = progress.litCount
  const result: Record<1 | 2 | 3 | 4, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (let s = 1; s < currentStage; s++) result[s as 1 | 2 | 3] = 4;
  result[currentStage as 1 | 2 | 3 | 4] = progress.litCount;
  return result;
}

/** 从 dict 里读 locale——MVP 简化，dict 不直接持 locale，stage 名走 dict.newJourney.stageNames。
 *  这里仅作为 Link href 的占位；运行时真正 locale 由父组件透传，MVP 跳过具体路径。 */
function dictStageLocale(dict: Dict): string {
  // Dict 没有显式 locale 字段；从 dict 中找一个有特征的 key 间接推断；
  // MVP 简化：直接落到 en，留给后续按 UI locale 注入
  return 'zh-CN';
}