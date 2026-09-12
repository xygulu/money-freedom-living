// 全局进度条（用户需求：所有页面固定可见）：挂在底部导航上方同一个 sticky
// 容器里，随导航一起贴底，全页可见且零页面 padding 改动。整体是去 /journey 的 Link。
// 量化口径诚实：位置 = 评估确认过的阶段（评估制，不是操作计数）；填充 =
// 已点亮的灯。没有评估过的阶段不造假进度——当前段从 0 开始，走到哪填到哪。
// 阶段 4 没有灯、没有终点线：整段淡色常亮，只表示「活法中」。纯静态填充，
// 无动画（尊重 prefers-reduced-motion）。
import Link from 'next/link';
import type { Dict } from '@/i18n/get-dict';
import type { Locale } from '@/i18n/config';
import type { GrowthProfile } from '@/lib/profile';
import { computeStageProgress, MAX_STAGE, STAGE_LAMPS } from '@/lib/stage';
import { getJourneyStage } from '@/lib/content';

export default function JourneyProgressBar({
  locale,
  dict,
  profile,
}: {
  locale: Locale;
  dict: Dict;
  profile: GrowthProfile | null;
}) {
  if (!profile) return null; // 未体检/身份解析失败：不渲染，layout 绝不因进度条挂掉

  const stage = profile.stage;
  const progress = computeStageProgress(stage, profile);
  const stageTitle = getJourneyStage(locale, stage)?.title ?? '';
  const label =
    stage >= MAX_STAGE
      ? dict.progress.livingLabel
      : dict.progress.stageLabel.replace('{n}', String(stage)).replace('{title}', stageTitle);

  return (
    <Link
      href={`/${locale}/journey`}
      aria-label={dict.progress.ariaLabel}
      className="flex items-center gap-3 border-b border-line px-5 py-2 transition-colors hover:bg-white/60"
    >
      <span className="shrink-0 text-xs text-ink-soft">{label}</span>
      <span className="flex flex-1 gap-1" aria-hidden>
        {[1, 2, 3, 4].map((id) => {
          if (id < stage) {
            // 已走过的阶段：整段实心
            return <span key={id} className="h-1.5 flex-1 rounded bg-accent" />;
          }
          if (id === stage) {
            if (id >= MAX_STAGE) {
              // 阶段 4 = 活法中：没有刻度，整段淡色
              return <span key={id} className="h-1.5 flex-1 rounded bg-accent/40" />;
            }
            // 当前阶段：按点亮灯数填充（各阶段灯数不同，按各自灯数算比例）
            const total = (STAGE_LAMPS[id] ?? []).length;
            const lit = total > 0 ? Math.round((progress.litCount / total) * 100) : 0;
            return (
              <span key={id} className="relative h-1.5 flex-1 overflow-hidden rounded bg-line">
                <span className="absolute inset-y-0 left-0 rounded bg-accent" style={{ width: `${lit}%` }} />
              </span>
            );
          }
          return <span key={id} className="h-1.5 flex-1 rounded bg-line" />;
        })}
      </span>
    </Link>
  );
}
