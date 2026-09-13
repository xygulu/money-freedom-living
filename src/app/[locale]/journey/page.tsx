// /[locale]/journey：旅程主页（docs/02 §5 每日节奏）。
// 今日三件事——全部可跳过，跳过不打断足迹，无未完成红点：
//   ① 今日一签（按当前阶段抽取；同一用户 90 天不重复，看过的记入档案 daily_seen）
//   ② 今日微行动（按当前阶段练习确定性抽取；"完成 + 一句感受"写入 experiments）
//   ③ 陪伴对话（进入 /chat，消耗会话配额）
// 阶段路标 + 当前位置 + 信件入口（阶段仪式：给现在的自己 / 写给钱的一封信）。
// 归来问候与发薪日锚点属 M7，这里不掺。
import { headers, cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDict } from '@/i18n/get-dict';
import { enabledLocales, isLocale } from '@/i18n/config';
import { getJourneyStages, pickDaily, pickExercise } from '@/lib/content';
import { resolveIdentity } from '@/lib/identity';
import { getProfile, recordDailySeen, type StageAssessment } from '@/lib/profile';
import { isAnchorDay } from '@/lib/anchor';
import { track } from '@/lib/analytics';
import { buildTimeline, formatTimelineDay } from '@/lib/timeline';
import { computeStageProgress, MAX_STAGE } from '@/lib/stage';
import { baselineFor, countMaterialSince, shouldPropose, saveEvolution, listPortraitVersions } from '@/lib/evolution';
import { shouldOfferAssess, saveAssessmentState, ASSESS_PENDING_TTL_DAYS } from '@/lib/assess';
import MicroActionCard from '@/components/MicroActionCard';
import StageLampChart from '@/components/StageLampChart';
import ActionRecordList from '@/components/ActionRecordList';
import AnchorCard from '@/components/AnchorCard';
import TimelineItemView from '@/components/TimelineItemView';
import AssessCard from '@/components/AssessCard';
import EvolveCard from '@/components/EvolveCard';

export const dynamic = 'force-dynamic';

const todayISO = () => new Date().toISOString().slice(0, 10);

export default async function journeyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);

  const headersList = await headers();
  const cookieList = await cookies();
  const identity = await resolveIdentity({ headers: headersList, cookies: cookieList });
  const profile = await getProfile(identity.key);

  const stage = profile?.stage ?? 1;
  const today = todayISO();

  const daily = pickDaily(locale, today, stage, (profile?.dailySeen ?? []).map((s) => s.text));
  if (daily && profile) {
    // 看过的签记入档案（幂等：同一天只记一条）；无档案（未体检）不记——去重从有档案起算
    try {
      await recordDailySeen(identity.key, today, daily.text);
    } catch (error) {
      console.error('[journey] recordDailySeen failed:', error);
    }
  }

  const exercise = pickExercise(locale, today, stage, identity.key);
  const stages = getJourneyStages(locale);
  const stageContent = stages.find((s) => s.id === stage) ?? null;
  const letterCount = profile?.letters.length ?? 0;

  // 阶段进度：灯 = 认知/行为里程碑，点亮真值是最近一次确认的评估
  // （assessment.confirmed.lamps——评估结论，不是动作档案；stamps 只是确认仪式
  // 同步留下的心印存档）。灯的依据来自同一份评估（evidence 随 confirmed 长期
  // 保存）；评估没说亮的灯一律未点亮。走过的段（s.id < stage）整段点亮——
  // 推进本身就是评估结论「本阶段程度已达成」。
  const confirmed = profile?.assessment.confirmed ?? null;
  // 灯的依据：当前确认评估优先；走过的段（灯 kind 已不在当前评估的灯集里）回落到
  // 上一次确认的报告——否则一推进，上一段三盏灯的依据就整段消失，只剩光秃秃的 ●
  const confirmedEvidence = new Map(
    [
      ...(profile?.assessment.previousConfirmed?.lamps ?? []),
      ...(profile?.assessment.confirmed?.lamps ?? []),
    ]
      .filter((l) => l.lit && l.evidence)
      .map((l) => [l.kind, l.evidence])
  );
  const nextStage = stages.find((s) => s.id === stage + 1) ?? null;

  // 「旅程中的我」预览（M9 需求①）：画像/足迹下钻入口 + 最近三步。
  // 无档案（还没体检）不显示——足迹从旅程第一步开始才有东西可看
  const growthPreview = profile ? await buildTimeline(identity.key, 3, 3) : [];

  // 演进提议（M9 需求②）：读时现算不落库（阈值改动立即生效，且 API 直刷过同一道判定）。
  // 首现写 proposedSeenAt + 埋点（演进成功会重置纪元，每纪元只记一次首现）。失败不阻塞页面。
  let evolveProposal = false;
  if (profile?.portrait) {
    try {
      const versions = await listPortraitVersions(identity.key);
      const baseline = baselineFor(profile, versions);
      const nowISO = new Date().toISOString();
      const counts = await countMaterialSince(identity.key, profile, baseline, nowISO);
      evolveProposal = shouldPropose(profile, counts, nowISO);
      if (evolveProposal && !profile.evolution.proposedSeenAt) {
        await saveEvolution(identity.key, { proposedSeenAt: nowISO });
        await track(identity.key, 'evolve_proposal_seen', {}, locale);
      }
    } catch (error) {
      console.error('[journey] evolve proposal failed:', error);
    }
  }

  // 阶段评估提议（M9 需求③语义修正）：评估的是「实际表现出的认知与行为」所
  // 处的位置，不是操作次数。读时现算不落库（同 evolve 哲学）；有待确认的评估
  // → review 卡（超 30 天 TTL 的遗留 pending 视为过期不再展示）；素材攒够 →
  // offer 卡，首现写 proposedSeenAt + 埋点。失败不阻塞页面。
  let assessPending: StageAssessment | null = null;
  let assessOffer = false;
  if (profile?.portrait) {
    try {
      const nowISO = new Date().toISOString();
      const st = profile.assessment;
      if (st.pending && Date.parse(nowISO) - Date.parse(st.pending.assessedAt) < ASSESS_PENDING_TTL_DAYS * 86_400_000) {
        assessPending = st.pending;
      } else {
        const baseline = st.confirmedAt ?? profile.created_at;
        const counts = await countMaterialSince(identity.key, profile, baseline, nowISO);
        assessOffer = shouldOfferAssess(profile, st, counts, nowISO);
        if (assessOffer && !st.proposedSeenAt) {
          await saveAssessmentState(identity.key, { proposedSeenAt: nowISO });
          await track(identity.key, 'stage_assessment_proposal_seen', { stage: String(stage) }, locale);
        }
      }
    } catch (error) {
      console.error('[journey] assess proposal failed:', error);
    }
  }

  // 归来问候（docs/02 §5）：暂停任意时长后回来给一句"欢迎回来，它还在"——
  // 不追责、不问为什么没来、不显示中断天数。隔 ≥3 天才算"归来"（连续使用不打扰）。
  let gapDays = -1;
  if (profile?.last_active_date) {
    gapDays = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${profile.last_active_date}T00:00:00Z`)) / 86_400_000);
  }
  const welcomeBack = gapDays >= 3;
  // 锚点日被动感知：只有用户自己设了锚点才会出现（默认不猜）
  const anchorToday = profile?.payday ? isAnchorDay(profile.payday) : false;

  // 验收指标：24h-72h 回访等（docs/02 §11）。查询端按 user+day 去重，这里无条件打点。
  const gapBucket = gapDays < 0 ? 'first' : gapDays === 0 ? 'same_day' : gapDays <= 3 ? '1-3' : gapDays <= 7 ? '4-7' : '8+';
  try {
    await track(identity.key, 'journey_visit', { gap: gapBucket }, locale);
  } catch {
    // 打点绝不阻塞页面
  }

  return (
    <div className="flex flex-col pt-16">
      <h1 className="text-2xl font-medium tracking-tight">{dict.journey.title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">{dict.journey.sub}</p>

      {welcomeBack && (
        <p className="mt-6 border border-dashed border-line bg-white/60 p-5 text-sm leading-relaxed">
          {dict.journey.welcomeBack}
        </p>
      )}
      {anchorToday && (
        <p className="mt-4 border border-line bg-white/60 p-5 text-sm leading-relaxed">
          {dict.journey.anchorDay}
        </p>
      )}

      <AnchorCard locale={locale} payday={profile?.payday ?? null} dict={dict} />

      {/* 演进提议卡：素材攒够时「我想重新看看你」——AI 提议，用户确认才重画 */}
      {evolveProposal && <EvolveCard locale={locale} dict={dict} />}

      {/* 阶段评估卡：AI 提议「看看你走到了哪里」——不是数做了多少次，
          而是看实际表现出的认知与行为。结果待确认时渲染 review 模式 */}
      {profile?.portrait && (assessPending || assessOffer) && (
        <AssessCard
          locale={locale}
          dict={dict}
          stage={stage}
          nextTitle={nextStage?.title ?? ''}
          actualTitle={stages.find((s) => s.id === (assessPending?.actualStage ?? stage))?.title ?? ''}
          pending={assessPending}
        />
      )}

      {daily && (
        <section className="mt-10 border border-line bg-white/60 p-6">
          <p className="text-xs tracking-widest text-ink-soft">{dict.journey.dailyLabel}</p>
          <p className="mt-4 text-lg leading-relaxed">{daily.text}</p>
          <p className="mt-4 text-sm text-ink-soft">
            {dict.journey.dailyReflect}：{daily.reflection}
          </p>
        </section>
      )}

      <section className="mt-8 border border-line p-6">
        <p className="text-xs tracking-widest text-ink-soft">{dict.journey.microLabel}</p>
        {exercise ? (
          <>
            <p className="mt-4 text-base leading-relaxed">{exercise}</p>
            {stageContent?.skippable && (
              <p className="mt-2 text-sm text-ink-soft/80">{dict.journey.microSkippable}</p>
            )}
            <MicroActionCard locale={locale} action={exercise} freeAlt={stageContent?.free_alt} skippable={stageContent?.skippable} dict={dict} />
          </>
        ) : (
          <p className="mt-4 text-sm text-ink-soft">{dict.journey.microNone}</p>
        )}
        <div className="mt-5 flex flex-wrap gap-3 text-sm">
          <Link href={`/${locale}/chat?start=1`} className="text-accent underline underline-offset-4">
            {dict.journey.microChatAlt}
          </Link>
          <span aria-hidden className="text-line">·</span>
          <span className="text-ink-soft">{dict.journey.microDailyOnly}</span>
        </div>
      </section>

      <section className="mt-8 border border-line p-6">
        <p className="text-xs tracking-widest text-ink-soft">{dict.journey.chatLabel}</p>
        <p className="mt-4 text-sm leading-relaxed text-ink-soft">{dict.journey.chatHint}</p>
        <Link
          href={`/${locale}/chat?start=1`}
          className="mt-5 inline-block border border-ink px-5 py-2.5 text-sm transition-colors hover:bg-ink hover:text-paper"
        >
          {dict.journey.chatCta}
        </Link>
      </section>

      <section className="mt-8 border border-dashed border-line p-6">
        <p className="text-xs tracking-widest text-ink-soft">{dict.journey.letterLabel}</p>
        <p className="mt-4 text-sm leading-relaxed text-ink-soft">{dict.journey.letterHint}</p>
        <Link href={`/${locale}/letters`} className="mt-5 inline-block text-accent underline underline-offset-4">
          {dict.journey.letterCta}
          {letterCount > 0 ? `（${letterCount}）` : ''}
        </Link>
      </section>

      {profile && (
        <section className="mt-8 border border-dashed border-line p-6">
          <p className="text-xs tracking-widest text-ink-soft">{dict.journey.growthLabel}</p>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {profile.portrait && (
              <Link href={`/${locale}/portrait`} className="text-accent underline underline-offset-4">
                {dict.journey.growthPortraitLink}
                {profile.portrait.version > 1 ? ` v${profile.portrait.version}` : ''}
              </Link>
            )}
            <Link href={`/${locale}/timeline`} className="text-accent underline underline-offset-4">
              {dict.journey.growthTrailLink}
            </Link>
          </div>
          {growthPreview.length > 0 ? (
            <ul className="mt-4 flex flex-col">
              {growthPreview.map((item, i) => (
                <li key={`growth-${i}`} className="border-t border-line py-4">
                  <p className="text-xs text-ink-soft/70">{formatTimelineDay(locale, item.date)}</p>
                  <div className="mt-2">
                    <TimelineItemView item={item} locale={locale} dict={dict} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm leading-relaxed text-ink-soft">{dict.journey.growthEmpty}</p>
          )}
          {growthPreview.length > 0 && (
            <Link href={`/${locale}/timeline`} className="mt-5 inline-block text-accent underline underline-offset-4">
              {dict.journey.growthMore} →
            </Link>
          )}
        </section>
      )}

      <h2 className="mt-14 text-sm tracking-widest text-ink-soft">{dict.journey.stages}</h2>
      <ol className="mt-4 flex flex-col">
        {stages.map((s) => {
          const locked = s.id === MAX_STAGE && s.id !== stage;
          const current = s.id === stage;
          const walked = s.id < stage;
          const stProgress = profile ? computeStageProgress(s.id, profile) : null;
          // 渲染侧按 kind 去重兜底（历史行可能带重复；appendStamps 已原子化并自愈存量）
          const seenStampKinds = new Set<string>();
          const stageStamps = (profile?.stamps ?? []).filter((st) => {
            if (!st.kind.startsWith(`stage${s.id}_`) || seenStampKinds.has(st.kind)) return false;
            seenStampKinds.add(st.kind);
            return true;
          });
          return (
            <li key={s.id} className="border-t border-line py-6">
              <div className="flex items-baseline justify-between gap-4">
                <h3 className={`text-base font-medium ${current ? '' : 'text-ink-soft'}`}>
                  {s.id} · {s.title}
                </h3>
                <span className="shrink-0 text-xs text-ink-soft">
                  {locked
                    ? dict.common.comingSoon
                    : current
                      ? dict.journey.stageWeeksRef.replace('{n}', String(s.weeks))
                      : dict.journey.weeks.replace('{n}', String(s.weeks))}
                </span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{s.goal}</p>
              {current && (
                <p className="mt-2 text-xs text-accent">● {dict.journey.currentStageNote}</p>
              )}

              {/* 走过的段：整段点亮（推进即评估结论「程度已达成」），灯不灭在呈现层
                  也成立——● + 依据（评估还在时显示），收起点亮标准，附该段心印 */}
              {walked && stProgress && stProgress.checks.length > 0 && (
                <div className="mt-5">
                  <p className="text-xs tracking-widest text-ink-soft">
                    {dict.journey.stageLampsLabel} · {stProgress.checks.length}/{stProgress.checks.length}
                  </p>
                  <ul className="mt-3 flex flex-col gap-2">
                    {stProgress.checks.map((c) => (
                      <li key={c.kind} className="text-sm leading-relaxed">
                        <span className="text-accent">● {(dict.journey as unknown as Record<string, string>)[c.labelKey] ?? c.labelKey}</span>
                        {confirmedEvidence.get(c.kind) && (
                          <span className="mt-1 block text-xs leading-relaxed text-ink-soft/80">
                            {dict.assess.evidenceLead}
                            {confirmedEvidence.get(c.kind)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* 这个阶段的灯：以图为中心——外圈=标准，点亮范围=现在的位置，
                  差距直观可见；未亮的灯展开点亮标准 + 行动入口，报告的行动
                  每条直接是按钮。灯 = 评估结论（最近一次确认评估的 lamps：
                  亮/不亮 + 依据），不是用户动作的记录。 */}
              {current && stProgress && stProgress.checks.length > 0 && (
                <StageLampChart
                  locale={locale}
                  dict={dict}
                  checks={stProgress.checks}
                  evidence={Object.fromEntries(confirmedEvidence)}
                  actions={confirmed?.actions ?? []}
                />
              )}
              {/* 阶段 4 无灯不画图，行动记录列表单独给（与灯图同一组件同一管线） */}
              {current && stProgress && stProgress.checks.length === 0 && confirmed && confirmed.actions.length > 0 && (
                <div className="mt-5">
                  <ActionRecordList
                    locale={locale}
                    dict={dict}
                    actions={confirmed.actions}
                    label={dict.assess.actionsLabel}
                  />
                </div>
              )}

              {/* 它看见的你：最近一次确认的评估报告（灯之外的诊断部分——为什么是
                  这里/离活法多远/下一步做什么）。确认后的评估不消失，常驻当前段，
                  标注评估当时的阶段——内容仍属那次评估，不因推进而改挂新段。 */}
              {current && confirmed && (
                <div className="mt-6 border-l-2 border-accent/50 pl-4">
                  <p className="text-xs tracking-widest text-ink-soft">{dict.assess.latestLabel}</p>
                  <p className="mt-1 text-xs text-ink-soft/70">
                    {dict.assess.latestStageNote.replace('{n}', String(confirmed.actualStage))}
                  </p>
                  <p className="mt-2 text-sm leading-relaxed">{confirmed.summary}</p>
                  <p className="mt-3 text-xs tracking-widest text-ink-soft">{dict.assess.diagnosisLabel}</p>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{confirmed.diagnosis}</p>
                  <p className="mt-3 text-xs tracking-widest text-ink-soft">{dict.assess.distanceLabel}</p>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{confirmed.distance}</p>
                  {/* 行动（actions）不再以文字列出——上方灯图的「下一步可以做什么」
                      按钮组承担（直接触发对话入口，非建议文案）；无灯阶段有独立按钮块 */}
                  <Link
                    href={`/${locale}/journey/changes`}
                    className="mt-4 inline-block text-sm text-accent underline underline-offset-4"
                  >
                    {dict.journey.changeListLink}
                  </Link>
                </div>
              )}

              {/* 阶段 4：没有灯，没有终点线——活法是把日子过下去 */}
              {current && s.id === MAX_STAGE && (
                <p className="mt-4 border-l-2 border-accent/50 pl-4 text-sm leading-relaxed text-ink-soft">
                  {dict.journey.stageNoFinishLine}
                </p>
              )}

              {/* 本段攒下的心印（含进入仪式印）——当前段与走过的段都显示，有才显示 */}
              {(current || walked) && stageStamps.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs tracking-widest text-ink-soft">{dict.journey.stageStampsLabel}</p>
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {stageStamps.map((st) => (
                      <li key={st.kind} className="border border-line px-2.5 py-1 text-xs text-ink-soft">
                        {(dict.stamps as unknown as Record<string, string>)[st.kind] ?? st.kind}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* 程度制联动：确认评估判本阶段灯全亮 ⇒ 下一阶段随之自动开启
                  （validate 硬约束 + confirm 收口 + getProfile 自愈，见 stage.ts
                  stageAdvanceTarget / assess.ts validateAssessment）——不需要用户
                  再做任何动作；评估判在门口（有灯未亮）才走 AssessCard 的
                  advance 确认流。 */}
            </li>
          );
        })}
      </ol>

      {/* 付费墙触发点③（soft gate）：阶段毕业想看深度报告时。MVP 中报告功能未上线，占位引导 */}
      <p className="mt-8 border-t border-line pt-6 text-xs leading-relaxed text-ink-soft/70">
        {dict.journey.reportTeaser}{' '}
        <Link href={`/${locale}/vip`} className="text-accent underline underline-offset-4">
          {dict.vip.vipLink}
        </Link>
      </p>
    </div>
  );
}
