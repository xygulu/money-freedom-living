// 全局进度条（用户需求：所有页面固定可见）：挂在底部导航上方同一个 sticky
// 容器里，随导航一起贴底，全页可见且零页面 padding 改动。整体是去 /journey 的 Link。
// 灯刻度（不做百分比——警惕会员积分/等级味）：四段按评估结论填充——走过的段
// 整段淡色（阶段推进只发生在评估确认仪式里，「走过」就是评估结论），当前段按
// 最近一次确认评估点亮的灯比例，未到的段全空。右侧显示当前阶段「已点亮 x/y 盏」，
// 位置由左侧「阶段 n」文案承担。阶段 4 没有灯、没有终点线：整段淡色常亮，只表示
// 「活法中」，不渲染右值。纯静态填充，无动画（尊重 prefers-reduced-motion）。
import Link from 'next/link';
import type { Dict } from '@/i18n/get-dict';
import type { Locale } from '@/i18n/config';
import type { GrowthProfile } from '@/lib/profile';
import { MAX_STAGE, stageLampScales } from '@/lib/stage';
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
  const scales = stageLampScales(profile);
  const current = scales.find((s) => s.id === stage)!;
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
        {scales.map(({ id, lit, total }) => {
          const pct = total > 0 ? Math.round((lit / total) * 100) : 0;
          if (id >= MAX_STAGE) {
            // 阶段 4 = 活法中：没有刻度，整段淡色
            return (
              <span
                key={id}
                data-segment={id}
                className={`h-1.5 flex-1 rounded ${id === stage ? 'bg-accent/40' : 'bg-line'}`}
              />
            );
          }
          return (
            <span key={id} data-segment={id} className="relative h-1.5 flex-1 overflow-hidden rounded bg-line">
              <span
                className={`absolute inset-y-0 left-0 rounded ${id === stage ? 'bg-accent' : 'bg-accent/50'}`}
                style={{ width: `${pct}%` }}
              />
            </span>
          );
        })}
      </span>
      {current.total > 0 && (
        <span className="shrink-0 text-xs text-ink-soft" data-lamp-count={`${current.lit}/${current.total}`}>
          {dict.progress.lampCount.replace('{lit}', String(current.lit)).replace('{total}', String(current.total))}
        </span>
      )}
    </Link>
  );
}
