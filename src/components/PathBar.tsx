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
//
// 对齐修复（2026-09-22，用户报「圆点和四个阶段没有对齐」）：原先点行靠左挤一条、
// 阶段行 grid 四等分摊满全行，且「当前段 4 点、其他段 3 点」让段边界随阶段漂移。
// 现在几何分段 = 逻辑分段：每段固定 4/4/3/3 格（合计 14），点行与阶段行共用同一组
// flex-grow，阶段节点永远落在自己那串点的正中央，段边界永不漂移。
import type { Dict } from '@/i18n/get-dict';
import type { StageProgress } from '@/lib/stage';
import styles from './PathBar.module.css';

interface Props {
  dict: Dict;
  stage: number;
  progress: StageProgress;
  /** 阶段名属于书（服务端从内容层按当前书解析好再传下来）——U6：书的语汇不得留在产品层 i18n */
  stageNames: string[];
}

/** 每段固定格数（4+4+3+3=14）：段与点的边界是几何事实，不随当前阶段漂移 */
const DOTS_PER_STAGE = [4, 4, 3, 3] as const;

type DotKind = 'lit' | 'breathing' | 'empty';

export default function PathBar({ dict, stage, progress, stageNames }: Props) {
  const t = dict.newJourney;

  // 把"已走的灯数"按当前阶段的进度比例映射到该段的格子上：
  // 已走段整段实心；当前段按 litCount/totalChecks 点亮，余下呼吸；未到段全空
  const litPerStage = computeLitPerStage(stage, progress);

  const groups = DOTS_PER_STAGE.map((n, gi) => {
    const s = (gi + 1) as 1 | 2 | 3 | 4;
    const lit = litPerStage[s] ?? 0;
    const totalInStage = s === stage ? Math.max(1, progress.checks.length || 4) : Math.max(1, n);
    const ratio = Math.max(0, Math.min(1, lit / totalInStage));
    const litDots = Math.floor(ratio * n);
    const kinds: DotKind[] = [];
    for (let i = 0; i < n; i++) {
      if (s < stage) kinds.push('lit');
      else if (s > stage) kinds.push('empty');
      else kinds.push(i < litDots ? 'lit' : 'breathing');
    }
    const state = s < stage ? '已走' : s === stage ? '当前' : '未到';
    return { s, kinds, state };
  });

  // 算"已亮"的总格数（lit + breathing 都算"走过"，empty 才算没走）
  const litCount = groups.reduce((acc, g) => acc + g.kinds.filter((k) => k !== 'empty').length, 0);

  // I 项：动态 hint 文案（不走 i18n 静态串）
  // 原型 line 482：「N 格亮着。这里不显示百分比，也不显示"还差几天"。」
  // 0 格亮 → "还没走过。不急。"
  const hint = litCount === 0 ? t.pathHintZero : t.pathHintLit.replace('{n}', String(litCount));

  return (
    <section className={styles.bar} data-step="path">
      <p className={styles.eyebrow}>{t.pathEyebrow}</p>
      {/* 点行与阶段行共用同一组 flex-grow（basis-0），两行分组宽度逐像素一致 */}
      <div className={styles.row} role="list" aria-label="阶段进度">
        {groups.map(({ s, kinds, state }) => (
          <span
            key={s}
            role="listitem"
            aria-label={`阶段 ${s} ${state}`}
            data-dot-group={s}
            className={styles.dotGroup}
            style={{ flexGrow: DOTS_PER_STAGE[s - 1] }}
          >
            {kinds.map((kind, i) => (
              <span
                key={i}
                aria-hidden="true"
                aria-label={kind === 'lit' ? '已走' : kind === 'breathing' ? '当前' : '未到'}
                className={`${styles.dot} ${styles[`dot_${kind}`]}`}
              />
            ))}
          </span>
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
            style={{ flexGrow: DOTS_PER_STAGE[s - 1] }}
          >
            <span className={styles.stageDot} aria-hidden="true" />
            <span className={styles.stageName}>{stageNames[s - 1] ?? String(s)}</span>
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
  // 简化：之前阶段整段走过，当前阶段 = progress.litCount
  const result: Record<1 | 2 | 3 | 4, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (let s = 1; s < currentStage; s++) result[s as 1 | 2 | 3] = 4;
  result[currentStage as 1 | 2 | 3 | 4] = progress.litCount;
  return result;
}
