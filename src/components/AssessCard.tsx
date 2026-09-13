'use client';

// 阶段评估卡（M9 需求③语义修正）：评估的是「实际表现出的认知与行为」所处的
// 位置，不是操作次数。offer 模式（pending=null）= AI 提议（首评在体检后就亮，
// 复评由素材闸控制）；review 模式 = 诊断式评估报告待确认：位置 + 灯 + 依据 +
// 总结 + 为什么是这里（diagnosis）+ 离活法多远（distance）+ 下一步做什么（actions）。
// 「记下现在的样子」才点亮新灯（只增不减）；「走进下一阶段」= 确认 + 推进；
// 「不是这样的」→ 14 天冷却，无惩罚。生成约 45-90 秒，busy 期不给按钮。
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Dict } from '@/i18n/get-dict';
import type { StageAssessment } from '@/lib/profile';
import { STAGE_LAMPS } from '@/lib/stage';

type AssessAction = 'generate' | 'confirm' | 'advance' | 'dismiss';

export default function AssessCard({
  locale,
  dict,
  stage,
  nextTitle,
  actualTitle,
  pending,
}: {
  locale: string;
  dict: Dict;
  stage: number;
  nextTitle: string; // 下一阶段名（「走进{stage}」按钮文案）
  actualTitle: string; // 评估出的位置的阶段名（结果行文案）
  pending: StageAssessment | null; // null = offer 模式
}) {
  const t = dict.assess;
  const router = useRouter();
  const [busy, setBusy] = useState<AssessAction | null>(null);
  const [error, setError] = useState('');

  async function act(action: AssessAction) {
    setBusy(action);
    setError('');
    try {
      const res = await fetch('/api/journey/assess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale, action }),
      });
      if (!res.ok) {
        setError(res.status === 429 && action === 'generate' ? t.busy : t.failed);
        setBusy(null);
        return;
      }
      setBusy(null);
      router.refresh(); // offer→结果卡、确认→灯亮/推进，都由服务端重渲染
    } catch {
      setError(t.failed);
      setBusy(null);
    }
  }

  if (!pending) {
    // offer 模式：AI 提议，用户点头才评估
    return (
      <div className="mt-6 border border-accent/50 bg-white/70 p-6" data-assess-offer>
        <p className="text-xs tracking-widest text-ink-soft">{t.label}</p>
        <p className="mt-3 text-base leading-relaxed">{t.invite}</p>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">{t.hint}</p>
        {busy === 'generate' ? (
          <p className="mt-5 text-sm leading-relaxed text-ink-soft">{t.busy}</p>
        ) : (
          <div className="mt-5">
            <button
              type="button"
              onClick={() => void act('generate')}
              className="border border-ink px-5 py-2.5 text-sm transition-colors hover:bg-ink hover:text-paper"
            >
              {t.cta}
            </button>
          </div>
        )}
        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
      </div>
    );
  }

  // review 模式：它看到的你——位置 + 灯 + 依据 + 总结，确认才作数
  const canAdvance = pending.actualStage > stage;
  const rules = new Map((STAGE_LAMPS[stage] ?? []).map((r) => [r.kind, r.labelKey]));

  return (
    <div className="mt-6 border border-accent/50 bg-white/70 p-6">
      <p className="text-xs tracking-widest text-ink-soft">{t.label}</p>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">{t.reviewIntro}</p>
      <p className="mt-2 text-base font-medium">
        {t.stageLine.replace('{n}', String(pending.actualStage)).replace('{title}', actualTitle)}
      </p>

      <ul className="mt-4 flex flex-col gap-2">
        {pending.lamps.map((l) => (
          <li key={l.kind} className="text-sm leading-relaxed">
            {l.lit ? (
              <>
                <span className="text-accent">● {(dict.journey as unknown as Record<string, string>)[rules.get(l.kind) ?? ''] ?? l.kind}</span>
                {l.evidence && (
                  <span className="mt-1 block text-xs leading-relaxed text-ink-soft/80">
                    {t.evidenceLead}
                    {l.evidence}
                  </span>
                )}
              </>
            ) : (
              <span className="text-ink-soft">
                ○ {(dict.journey as unknown as Record<string, string>)[rules.get(l.kind) ?? ''] ?? l.kind}
              </span>
            )}
          </li>
        ))}
      </ul>

      <p className="mt-5 text-xs tracking-widest text-ink-soft">{t.summaryLabel}</p>
      <p className="mt-2 text-sm leading-relaxed">{pending.summary}</p>
      <p className="mt-4 text-xs tracking-widest text-ink-soft">{t.diagnosisLabel}</p>
      <p className="mt-2 text-sm leading-relaxed">{pending.diagnosis}</p>
      <p className="mt-4 text-xs tracking-widest text-ink-soft">{t.distanceLabel}</p>
      <p className="mt-2 text-sm leading-relaxed">{pending.distance}</p>
      <p className="mt-4 text-xs tracking-widest text-ink-soft">{t.actionsLabel}</p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {pending.actions.map((a, i) => (
          <li key={i} className="text-sm leading-relaxed">
            · {a}
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs tracking-widest text-ink-soft">{t.nextLabel}</p>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">{pending.nextHint}</p>

      <div className="mt-5 flex flex-wrap items-center gap-4">
        {busy === 'confirm' || busy === 'advance' ? (
          <p className="text-sm leading-relaxed text-ink-soft">{t.busy}</p>
        ) : (
          <>
            {canAdvance && (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void act('advance')}
                className="border border-ink px-5 py-2.5 text-sm transition-colors hover:bg-ink hover:text-paper disabled:opacity-50"
              >
                {t.advanceCta.replace('{stage}', nextTitle)}
              </button>
            )}
            {/* 程度制：评估判定到下一阶段（本阶段灯全亮）时不再提供「留在阶段 n」
                ——阶段完成即开启；不同意这份评估走 dismiss（14 天冷却） */}
            {!canAdvance && (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void act('confirm')}
                className="border border-ink px-5 py-2.5 text-sm transition-colors hover:bg-ink hover:text-paper"
              >
                {t.confirmCta}
              </button>
            )}
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void act('dismiss')}
              className="text-sm text-ink-soft underline underline-offset-4 hover:text-ink"
            >
              {t.dismissCta}
            </button>
          </>
        )}
      </div>
      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
    </div>
  );
}
