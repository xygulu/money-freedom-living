'use client';

// 阶段灯图（呈现层「以图为中心」）：当前阶段的灯画在一张雷达式图上——外圈
// （虚线）= 这个阶段应达的程度（标准），点亮顶点的连线范围 = 用户现在的位置，
// 差距一眼可见（哪几面亮了、哪几面还空着）。不画数值刻度：灯只有亮/不亮 +
// 依据（程度制），「差距」由图形表达，不由百分比表达。图下每盏灯一行：
// 未亮的展开点亮标准 + 「对它说说这件事」的行动入口；已亮的展开评估依据。
// 再往下是评估报告的「下一步可以做什么」——每条直接是按钮（触发对话入口），
// 不是建议文案。走过的段不用这张图（陈列用文字灯即可），阶段 4 无灯不画。
import { useState } from 'react';
import Link from 'next/link';
import type { Dict } from '@/i18n/get-dict';
import type { StageCheck } from '@/lib/stage';
import { lampChartPoints } from '@/lib/stage';

const CX = 110; // SVG 视窗中心/半径（viewBox 220×200，顶点落在圆上，四周留标签余量）
const CY = 100;
const R = 64;

export default function StageLampChart({
  locale,
  dict,
  checks,
  evidence,
  actions,
}: {
  locale: string;
  dict: Dict;
  checks: StageCheck[];
  evidence: Record<string, string>; // 评估依据随灯显示（服务端已按 kind 摘好；对象可跨 RSC 边界）
  actions: string[]; // 最近一次确认评估的下一步行动（每条一个按钮）
}) {
  const t = dict.journey;
  const lampName = (labelKey: string) => (dict.journey as unknown as Record<string, string>)[labelKey] ?? labelKey;
  const litCount = checks.filter((c) => c.done).length;
  // 默认展开第一盏未亮的灯——引导从「还差的那面」开始；全亮则不展开
  const [open, setOpen] = useState<number | null>(() => {
    const i = checks.findIndex((c) => !c.done);
    return i === -1 ? null : i;
  });
  const chatHref = `/${locale}/chat`;

  const pts = lampChartPoints(checks.length).map((p) => ({
    x: CX + (p.x - 0.5) * 2 * R,
    y: CY + (p.y - 0.5) * 2 * R,
  }));
  const litPts = checks.map((c, i) => (c.done ? pts[i] : null)).filter((p) => p !== null);
  const polygon = litPts.length >= 2 ? litPts.map((p) => `${p.x},${p.y}`).join(' ') : '';

  return (
    <div className="mt-5" data-lamp-chart>
      <svg viewBox="0 0 220 200" className="mx-auto block w-full max-w-[240px]" role="img" aria-label={t.stageLampsLabel}>
        {/* 外圈 = 标准（这个阶段应达的程度）；虚线细圈，不压迫 */}
        <circle cx={CX} cy={CY} r={R} fill="none" className="stroke-line" strokeWidth="1.5" strokeDasharray="3 4" />
        {/* 点亮范围 = 用户现在的位置（至少两盏亮才连形；一盏亮只是节点本身） */}
        {polygon && <polygon points={polygon} className="fill-accent stroke-accent" fillOpacity="0.12" strokeOpacity="0.45" strokeWidth="1.5" />}
        {checks.map((c, i) => {
          const p = pts[i];
          const toggle = () => setOpen(open === i ? null : i);
          return c.done ? (
            <g key={c.kind} data-lamp-node={c.kind} data-lit="1" onClick={toggle} className="cursor-pointer">
              <circle cx={p.x} cy={p.y} r="12" className="fill-accent" fillOpacity="0.15" />
              <circle cx={p.x} cy={p.y} r="6.5" className="fill-accent" />
            </g>
          ) : (
            <g key={c.kind} data-lamp-node={c.kind} data-lit="0" onClick={toggle} className="cursor-pointer">
              <circle cx={p.x} cy={p.y} r="14" fill="transparent" />
              <circle cx={p.x} cy={p.y} r="6" className="fill-paper stroke-ink-soft" strokeWidth="1.5" />
            </g>
          );
        })}
      </svg>
      <p className="mt-2 text-center text-xs leading-relaxed text-ink-soft/70" data-lamp-caption>
        {t.lampChartCaption}
      </p>

      <p className="mt-4 text-xs tracking-widest text-ink-soft">
        {t.stageLampsLabel} · {dict.progress.lampCount.replace('{lit}', String(litCount)).replace('{total}', String(checks.length))}
      </p>
      <ul className="mt-3 flex flex-col gap-1">
        {checks.map((c, i) => {
          const hint = (dict.journey as unknown as Record<string, string>)[`${c.labelKey}Hint`];
          return (
            <li key={c.kind} data-lamp-row={c.kind}>
              <button
                type="button"
                onClick={() => setOpen(open === i ? null : i)}
                className="w-full py-1.5 text-left text-sm leading-relaxed"
                aria-expanded={open === i}
              >
                <span className={c.done ? 'text-accent' : 'text-ink-soft'}>
                  {c.done ? '●' : '○'} {lampName(c.labelKey)}
                </span>
              </button>
              {open === i && (
                <div className="pb-2 pl-5">
                  {c.done ? (
                    evidence[c.kind] && (
                      <p className="text-xs leading-relaxed text-ink-soft/80">
                        {dict.assess.evidenceLead}
                        {evidence[c.kind]}
                      </p>
                    )
                  ) : (
                    <>
                      {hint && (
                        <p className="text-xs leading-relaxed text-ink-soft/70">
                          {t.stageLampHintLead}
                          {hint}
                        </p>
                      )}
                      <Link
                        href={chatHref}
                        data-lamp-cta={c.kind}
                        className="mt-2 inline-block border border-ink px-4 py-1.5 text-sm transition-colors hover:bg-ink hover:text-paper"
                      >
                        {t.lampActCta} →
                      </Link>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {litCount < checks.length && <p className="mt-3 text-xs text-ink-soft/70">{t.stageLampWaiting}</p>}

      {actions.length > 0 && (
        <div className="mt-5 border-t border-line pt-4">
          <p className="text-xs tracking-widest text-ink-soft">{dict.assess.actionsLabel}</p>
          <div className="mt-3 flex flex-col gap-2">
            {actions.map((a, i) => (
              <Link
                key={i}
                href={chatHref}
                data-action-cta={String(i)}
                className="flex items-center justify-between gap-3 border border-ink px-4 py-2.5 text-sm leading-relaxed transition-colors hover:bg-ink hover:text-paper"
              >
                <span>{a}</span>
                <span aria-hidden>→</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
