'use client';

// 前台改造（70-2 B4）· 你的路（PathBar）：14 格 + 4 阶段节点。
//
// 70-2 加固（H/I 项）按原型重做：
// - 4 个阶段节点**只是文字，不是 Link**（原型 line 269-271 是 <span>，无 href）——
//   原版硬编码 Link 是过度工程，原型根本不跳。删 `dictStageLocale()` 死代码。
// - hint 文案**动态生成**（原型 line 482）：`${n} 格亮着。这里不显示百分比，
//   也不显示"还差几天"。` 不再走 i18n 静态串。
//
// 14 个圆点串成一行（已走=实心/当前=呼吸/未到=虚线）。
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

  // 算"已亮"的总格数（lit + breathing 都算"走过"，empty 才算没走）
  const litCount = dots.filter((d) => d === 'lit' || d === 'breathing').length;

  // I 项：动态 hint 文案（不走 i18n 静态串）
  // 原型 line 482：「N 格亮着。这里不显示百分比，也不显示"还差几天"。」
  // 0 格亮 → "还没走过。不急。"
  const hint = litCount === 0 ? t.pathHintZero : t.pathHintLit.replace('{n}', String(litCount));

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
      {/* H 项：4 个阶段节点用 span，不是 Link；原型 line 269-271 */}
      <div className={styles.stages} role="list" data-stage-labels>
        {[1, 2, 3, 4].map((s) => (
          <span
            key={s}
            role="listitem"
            aria-current={s === stage ? 'true' : undefined}
            className={`${styles.stage} ${s === stage ? styles.stageOn : ''}`}
            data-stage={s}
          >
            <span className={styles.stageDot} aria-hidden="true" />
            <span className={styles.stageName}>{stageNames[s - 1] ?? `阶段 ${s}`}</span>
          </span>
        ))}
      </div>
      <p className={styles.hint} data-path-hint>{hint}</p>
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
