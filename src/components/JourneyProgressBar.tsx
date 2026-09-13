// 全局进度条（用户指令：所有阶段与各段进度全部可见——像阶梯一样一段不藏）：
// 挂在底部导航上方同一个 sticky 容器里，整体是去 /journey 的 Link。四段各占
// 一列，每列 = 段名（阶段 n·标题 / 活法中）+ 该段进度 + 该段灯数——走过的段
// 整段淡色填充（阶段推进只发生在评估确认仪式里，「走过」就是评估结论），当前
// 段按最近一次确认评估点亮的灯比例，未到的段空。阶段 4 没有灯、没有终点线：
// 段名常显、当前时整条淡色，只表示「活法中」，无计数。不做百分比/「还差多少」
// 文案——数字只是灯数（lit/total），与旅程页灯图同源（stageLampScales）。
// 纯静态填充，无动画（尊重 prefers-reduced-motion）。
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

  return (
    <Link
      href={`/${locale}/journey`}
      aria-label={dict.progress.ariaLabel}
      className="block border-b border-line px-5 py-2 transition-colors hover:bg-white/60"
    >
      <span className="flex items-start gap-2" aria-hidden>
        {scales.map(({ id, lit, total }) => {
          const isStage4 = id >= MAX_STAGE;
          const isCurrent = id === stage;
          const isWalked = id < stage;
          const title = getJourneyStage(locale, id)?.title ?? '';
          const name = isStage4
            ? dict.progress.livingLabel
            : dict.progress.stageLabel.replace('{n}', String(id)).replace('{title}', title);
          const pct = total > 0 ? Math.round((lit / total) * 100) : 0;
          return (
            <span key={id} data-stage-cell={id} className="flex min-w-0 flex-1 flex-col gap-1">
              <span
                className={`truncate text-[10px] leading-none ${
                  isCurrent ? 'font-medium text-accent' : isWalked ? 'text-ink-soft' : 'text-ink-soft/60'
                }`}
              >
                {name}
              </span>
              <span className="flex items-center gap-1">
                <span data-segment={id} className="relative h-1.5 flex-1 overflow-hidden rounded bg-line">
                  {isStage4 ? (
                    isCurrent && <span className="absolute inset-0 rounded bg-accent/40" />
                  ) : (
                    <span
                      className={`absolute inset-y-0 left-0 rounded ${isCurrent ? 'bg-accent' : 'bg-accent/50'}`}
                      style={{ width: `${pct}%` }}
                    />
                  )}
                </span>
                {!isStage4 && (
                  <span
                    className="shrink-0 text-[10px] leading-none tabular-nums text-ink-soft"
                    data-lamp-count={isCurrent ? `${lit}/${total}` : undefined}
                  >
                    {`${lit}/${total}`}
                  </span>
                )}
              </span>
            </span>
          );
        })}
      </span>
    </Link>
  );
}
