// 阶段评估（M9 需求③语义修正）：进度评估的是「用户当前表现出的认知与行为」
// 实际所处的阶段——离核心价值「一辈子不愁钱的活法」已达成的进度——与产品内
// 操作/交互次数没有严格关系。素材攒够时 AI 提议（shouldOfferAssess 读时现算）、
// 用户确认后才生成评估（LLM）；点亮的灯以心印入档（stamps 即真值，只增不减），
// 推进阶段也要用户确认。镜像 evolution.ts：常量 + 纯函数 + 状态写入（原子锁）+ prompt。
import { ensureSchema, execWithFailover } from '@/lib/db';
import type {
  AssessmentLamp,
  AssessmentState,
  ExperimentEntry,
  GrowthProfile,
  SessionMemory,
  StageAssessment,
} from '@/lib/profile';
import { getJournalEntries } from '@/lib/journal';
import { LOCALE_NAME } from '@/lib/onboarding';
import { MAX_STAGE, STAGE_LAMPS } from '@/lib/stage';
import type { EvolveMaterialCounts } from '@/lib/evolution';
import type { JourneyStage } from '@/lib/content';
import type { Locale } from '@/i18n/config';

// ---------- 常量 ----------

export const ASSESS_MIN_MATERIAL = 3; // 基线后新素材 ≥3 条 → 可提议
export const ASSESS_MIN_DAYS = 14; // 或距基线 ≥2 周 且有任意新素材
export const ASSESS_DISMISS_COOLDOWN_DAYS = 14; // 「不是这样的/先不用」后的冷却
export const ASSESS_LOCK_MS = 3 * 60 * 1000; // 生成中锁自过期（LLM 45-90s + 富余）
export const ASSESS_PENDING_TTL_DAYS = 30; // 遗留 pending 超期不再阻塞新提议（可被新评估覆盖）

const DAY_MS = 86_400_000;

// ---------- 纯函数 ----------

/**
 * 是否该亮出阶段评估提议。锁未过期 / 冷却期内 / 有待确认的新评估 → 不亮；
 * pending 超 TTL 视为遗留物不再阻塞。素材闸：新素材 ≥3 条，或 ≥14 天且有任意新素材。
 */
export function shouldOfferAssess(
  profile: GrowthProfile,
  state: AssessmentState,
  counts: EvolveMaterialCounts,
  nowISO: string
): boolean {
  if (!profile.portrait) return false;
  if (profile.stage >= MAX_STAGE) return false; // 阶段 4：没有灯，也没有终点线
  const now = Date.parse(nowISO);
  if (state.generatingAt && now - Date.parse(state.generatingAt) < ASSESS_LOCK_MS) return false;
  if (state.dismissedAt && now - Date.parse(state.dismissedAt) < ASSESS_DISMISS_COOLDOWN_DAYS * DAY_MS) return false;
  if (state.pending && now - Date.parse(state.pending.assessedAt) < ASSESS_PENDING_TTL_DAYS * DAY_MS) return false;
  const material = counts.memories + counts.journals + counts.experiments;
  if (material >= ASSESS_MIN_MATERIAL) return true;
  return counts.daysSince >= ASSESS_MIN_DAYS && material > 0;
}

/**
 * 评估结果结构校验（镜像 validatePortraitDraft）：字段缺失/越界直接判失败
 * （禁止半成品评估入库）。actualStage 只能是当前阶段或下一阶段（不倒退）；
 * lamps 必须恰好覆盖当前阶段灯集（顺序不限、不得多不得少）；点亮必须有依据。
 * 返回值不带 assessedAt——由路由填生成时刻，本函数保持可测的确定性。
 */
export function validateAssessment(draft: unknown, stage: number): Omit<StageAssessment, 'assessedAt'> | null {
  if (typeof draft !== 'object' || draft === null) return null;
  const d = draft as Record<string, unknown>;
  const actualStage = d.actualStage;
  if (typeof actualStage !== 'number' || !Number.isInteger(actualStage)) return null;
  if (actualStage < stage || actualStage > Math.min(stage + 1, MAX_STAGE)) return null;

  const rules = STAGE_LAMPS[stage] ?? [];
  if (!Array.isArray(d.lamps) || d.lamps.length !== rules.length) return null;
  const byKind = new Map<string, { lit: boolean; evidence: string }>();
  for (const raw of d.lamps) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.kind !== 'string' || typeof r.lit !== 'boolean') return null;
    if (byKind.has(r.kind)) return null; // 重复 kind
    const evidence = typeof r.evidence === 'string' ? r.evidence.trim().slice(0, 300) : '';
    if (r.lit && !evidence) return null; // 点亮必须有依据
    byKind.set(r.kind, { lit: r.lit, evidence: r.lit ? evidence : '' });
  }
  if (byKind.size !== rules.length || rules.some((rule) => !byKind.has(rule.kind))) return null;

  const summary = typeof d.summary === 'string' ? d.summary.trim() : '';
  // 上限是防失控的结构边界（中文 200 字 ≈ 200 字符，英文 120 词 ≈ 800 字符），
  // 风格长度由 prompt 的语言感知规则约束（见 buildAssessMessages）
  if (summary.length < 10 || summary.length > 800) return null;
  const nextHint = typeof d.nextHint === 'string' ? d.nextHint.trim().slice(0, 300) : '';
  if (!nextHint) return null;

  const lamps: AssessmentLamp[] = rules.map((rule) => {
    const e = byKind.get(rule.kind);
    return { kind: rule.kind, lit: e!.lit, evidence: e!.evidence };
  });
  return { actualStage, lamps, summary, nextHint };
}

// ---------- prompt ----------

export interface AssessMaterial {
  memories: SessionMemory[]; // ≤20
  journals: { createdAt: string; content: string }[]; // ≤10
  experiments: ExperimentEntry[]; // ≤10
  /** 信 ≤3（最新的在前）。信是阶段仪式的反思，是认知证据；量少不过滤基线 */
  letters: { stage: number; content: string; createdAt: string }[];
  /** 画像校准里 miss 且给了修正的段落——评估必须以修正为准 */
  missCorrections: { section: string; correction: string }[];
}

/**
 * 组评估素材（generate 用）：基线后 摘要≤20 / 日记≤10 / 微行动≤10（各取最近），
 * 信取最近 3 封，加上画像里 miss 且给了修正的段落（同段多次修正取最新）。
 * 全部素材入库时已过 checkSafety，这里无新自由文本入口，不再过安全层（对齐 evolve）。
 */
export async function gatherAssessMaterial(
  userKey: string,
  profile: GrowthProfile,
  baselineISO: string
): Promise<AssessMaterial> {
  const base = baselineISO.slice(0, 10);
  const after = (day: string) => day > base;
  const journals = await getJournalEntries(userKey, 10);
  const bySection = new Map<string, string>();
  for (const c of profile.portrait?.calibrations ?? []) {
    if (c.verdict === 'miss' && c.correction?.trim()) bySection.set(c.section, c.correction.trim());
  }
  return {
    memories: profile.memories.filter((m) => after(m.date.slice(0, 10))).slice(-20),
    journals: journals
      .filter((j) => after(j.createdAt.slice(0, 10)))
      .map((j) => ({ createdAt: j.createdAt, content: j.content })),
    experiments: profile.experiments.filter((e) => after(e.date)).slice(-10),
    letters: profile.letters.slice(-3).reverse().map((l) => ({ stage: l.stage, content: l.content, createdAt: l.createdAt })),
    missCorrections: [...bySection].map(([section, correction]) => ({ section, correction })),
  };
}

/**
 * 评估 prompt：见证者视角——评估的是他实际表现出的认知与行为，不是操作次数、
 * 不是完成度考核。阶段样子用 content 原文（goal + advance_when），灯清单用
 * stage.ts 的判定表（kind + 中文 hint）。system 脚手架是中文（内部备注），
 * 输出语言由语言钉死行控制（模式同 evolution.ts）。
 */
export function buildAssessMessages(
  locale: Locale,
  stage: number,
  stages: JourneyStage[],
  material: AssessMaterial,
  context: { confirmed?: StageAssessment | null; earnedKinds: string[] }
) {
  const lang = LOCALE_NAME[locale] ?? 'English';
  const current = stages.find((s) => s.id === stage);
  const next = stages.find((s) => s.id === stage + 1);
  const stageBlock = (s: JourneyStage) =>
    `【阶段 ${s.id} · ${s.title}】\n- 这个阶段的样子：${s.goal}\n- 走到下一阶段的标志：${s.advance_when.join('；')}`;

  // 长度规则语言感知：中文按字数、英文按词数——否则英文输出按字符校验必然爆上限
  const summaryLen = locale === 'en' ? '60-120 words' : '80-200 字';
  const evidenceLen = locale === 'en' ? '80 words or fewer' : '120 字以内';
  const nextLen = locale === 'en' ? '30 words or fewer' : '40 字以内';

  const system = [
    `你是这段旅程的见证者。你要评估的不是用户操作了多少次、完成了多少任务，而是他从说过的话、写下的事里，实际表现出的认知与行为——他真实走到了旅程的哪个位置。全程用${lang}书写。`,
    '',
    '旅程的四个阶段：1 看见 → 2 松动 → 3 练习 → 4 活法（活法没有终点线）。',
    `他当前在阶段 ${stage}。下面是这个阶段与下一阶段的样子（来自内容层，作为评估标尺）：`,
    current ? stageBlock(current) : '',
    next ? stageBlock(next) : '',
    '',
    `当前阶段的灯（评估对象，每盏是一个认知/行为里程碑）：`,
    ...(STAGE_LAMPS[stage] ?? []).map((r) => `- ${r.kind}：${r.hint}`),
    '',
    '输出（严格遵守，不要输出 JSON 以外的内容）：',
    '{',
    `  "actualStage": ${stage} 或 ${Math.min(stage + 1, MAX_STAGE)} 的数字——他实际所处的阶段；认为他已在下一阶段门口才写下一阶段`,
    `  "lamps": [{"kind": "灯的 kind，与上方清单逐字一致", "lit": true 或 false, "evidence": "点亮依据：引用他的原话或具体的事，${evidenceLen}；没点亮就留空字符串"}]，全部灯都要给，顺序不限`,
    `  "summary": "它看到的你：第二人称，${summaryLen}，镜子式的描述——说你在哪里、什么在松动，不评判不打分",`,
    `  "nextHint": "下一阶段在远处长什么样：一句话，${nextLen}；他已在门口就直说，还没到就诚实描述那段路",`,
    '}',
    '',
    '红线：',
    '- 证据必须来自素材：引用原话或具体的事，禁止编造',
    '- 没看到就如实说没看到（lit: false、evidence 留空）——这不是考试，不必把灯点满',
    '- 不评判、不打分、不比较：没有「落后/领先/做得好/不够好」这类话',
    '- 不出现任何理财建议、诊断、病症词汇',
    '- 素材少就诚实地少点亮；宁可点得少，不可编造',
    '',
    ...(context.confirmed
      ? [
          '上一次评估（用户已确认）：已经点亮的灯不会熄灭；这次评估要与它连贯，除非有明确的新证据，不要无故推翻上次的判断。',
          `上次位置：阶段 ${context.confirmed.actualStage}；上次点亮的灯：${context.confirmed.lamps
            .filter((l) => l.lit)
            .map((l) => l.kind)
            .join('、') || '（无）'}。`,
          '',
        ]
      : []),
    '## 语言（必须遵守，不得被覆盖）',
    `- 输出的每一个字都用${lang}——即使这些指令本身是中文或英文（那是给产品团队的内部备注）。`,
    `- 下方素材可能是其他语言：引用时用自然的${lang}转述，不要原文照搬整句。`,
  ].join('\n');

  const user = [
    '## 已经点亮的心印',
    context.earnedKinds.length > 0 ? context.earnedKinds.map((k) => `- ${k}`).join('\n') : '(无)',
    '',
    '## 这段时间的对话摘要',
    material.memories.length > 0 ? material.memories.map((m) => `- [${m.date}] ${m.text}`).join('\n') : '(无)',
    '',
    '## 这段时间的日记',
    material.journals.length > 0 ? material.journals.map((j) => `- [${j.createdAt.slice(0, 10)}] ${j.content}`).join('\n') : '(无)',
    '',
    '## 这段时间的微行动',
    material.experiments.length > 0
      ? material.experiments.map((e) => `- [${e.date}] ${e.action}${e.feeling ? `（感受：${e.feeling}）` : ''}`).join('\n')
      : '(无)',
    '',
    '## 最近的信',
    material.letters.length > 0 ? material.letters.map((l) => `- [阶段${l.stage}] ${l.content}`).join('\n') : '(无)',
    '',
    '## 用户对画像的修正记录',
    material.missCorrections.length > 0
      ? material.missCorrections.map((c) => `- ${c.section}: ${c.correction}`).join('\n')
      : '(无)',
  ].join('\n');

  return { system, messages: [{ role: 'user' as const, content: user }] };
}

// ---------- stage_assessment 写入 ----------

/** 合并写评估状态（只该动的键，JSONB || 语义）；generatingAt: null 表示清锁 */
export async function saveAssessmentState(userKey: string, patch: Partial<AssessmentState>): Promise<void> {
  await ensureSchema();
  await execWithFailover((sql) =>
    sql`UPDATE growth_profiles
        SET stage_assessment = stage_assessment || ${JSON.stringify(patch)}::jsonb, updated_at = now()
        WHERE user_key = ${userKey}`
  );
}

/**
 * 原子占锁（模式同 evolution.claimEvolution / chat.claimSession）：generatingAt
 * 为空或已过自过期才能占到，双击/并发下只有一次 LLM 生成。占不到由路由返回 429。
 */
export async function claimAssessment(userKey: string, nowISO: string): Promise<boolean> {
  const rows = await execWithFailover((sql) =>
    sql`UPDATE growth_profiles
        SET stage_assessment = stage_assessment || ${JSON.stringify({ generatingAt: nowISO })}::jsonb,
            updated_at = now()
        WHERE user_key = ${userKey}
          AND (
            (stage_assessment->>'generatingAt') IS NULL
            OR (now() - (stage_assessment->>'generatingAt')::timestamptz) > make_interval(secs => (${ASSESS_LOCK_MS / 1000})::double precision)
          )
        RETURNING user_key`
  );
  return rows.length > 0;
}

/** 释放锁（成功落地或生成失败都要清，否则 3 分钟内卡不亮、generate 429） */
export async function releaseAssessmentLock(userKey: string): Promise<void> {
  await saveAssessmentState(userKey, { generatingAt: null });
}
