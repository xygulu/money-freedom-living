// 区域视图（M11-D，docs/05 §3.1）：四段不是「进度条」，是**四个区域**。
//
// 为什么改：进度条建模的是「我完成了百分之多少」——接第二本书时，用户会觉得
// 进度清零、前面白做了。区域建模的是「地图变大了」：走过的区域永远在地图上，
// 新书只是把地图铺得更远。所以这里**不再画百分比填充条**，改成每个区域一串灯
// 点（● 亮 / ○ 未亮）——灯只有亮不亮，没有半盏（程度制），条形填充本来就在
// 谎报精度。阶段 4 无灯，只标「活法中」。
//
// 还没走到的区域是**远处那座塔**，不是欠账（docs/05 §8.1）：虚线、淡色、不计数、
// 不催。挂在底部导航上方同一个 sticky 容器里，整体是去 /journey 的 Link。
// 纯静态，无动画（尊重 prefers-reduced-motion）。
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
          const state = isCurrent ? 'current' : isWalked ? 'walked' : 'ahead';
          // 四段统一「阶段 n·标题」——阶段 4 的标题就是「活法」，不再用状态词特例
          const title = getJourneyStage(locale, id)?.title ?? '';
          const name = dict.progress.stageLabel.replace('{n}', String(id)).replace('{title}', title);
          return (
            <span key={id} data-stage-cell={id} className="flex min-w-0 flex-1 flex-col gap-1">
              <span
                className={`truncate text-[10px] leading-none ${
                  isCurrent ? 'font-medium text-accent' : isWalked ? 'text-ink-soft' : 'text-ink-soft/60'
                }`}
              >
                {name}
              </span>
              <span
                data-segment={id}
                data-zone-state={state}
                className={`flex h-4 items-center gap-1 rounded px-1.5 ${
                  isCurrent
                    ? 'bg-accent/10 ring-1 ring-accent/40'
                    : isWalked
                      ? 'bg-accent/5'
                      : 'border border-dashed border-line'
                }`}
              >
                {isStage4 ? (
                  // 阶段 4 没有灯、没有终点线：只标一句「活法中」，不计数
                  <span className="truncate text-[9px] leading-none text-ink-soft/70">
                    {isCurrent ? dict.progress.livingLabel : dict.progress.zoneAhead}
                  </span>
                ) : (
                  <>
                    {Array.from({ length: total }, (_, i) => (
                      <span
                        key={i}
                        data-zone-lamp={i < lit ? '1' : '0'}
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          i < lit ? (isCurrent ? 'bg-accent' : 'bg-accent/50') : 'bg-line'
                        }`}
                      />
                    ))}
                    <span
                      className="ml-auto shrink-0 text-[10px] leading-none tabular-nums text-ink-soft"
                      data-lamp-count={isCurrent ? `${lit}/${total}` : undefined}
                    >
                      {`${lit}/${total}`}
                    </span>
                  </>
                )}
              </span>
            </span>
          );
        })}
      </span>
    </Link>
  );
}
