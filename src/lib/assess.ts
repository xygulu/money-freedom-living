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
import { MAX_STAGE, STAGE_LAMPS, actionEvidenceKinds } from '@/lib/stage';
import type { EvolveMaterialCounts } from '@/lib/evolution';
import { TOPICS_ZH, type JourneyStage } from '@/lib/content';
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
 * pending 超 TTL 视为遗留物不再阻塞。首评闸：从未确认过任何评估（confirmedAt 为空）
 * → 体检画像本身就是评估素材（阶段 1 三盏灯的判定 hint 本就对应问卷原话/spoken/
 * moments/baseColor/旧脚本），不受素材闸限制——否则新用户在攒够 3 条素材前永远
 * 没有第一次评估。素材闸：新素材 ≥3 条，或 ≥14 天且有任意新素材。
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
  if (!state.confirmedAt) return true; // 首评闸：只看是否确认过——冷却过期仍会再提，pending 超 TTL 可覆盖重评
  const material = counts.memories + counts.journals + counts.experiments;
  if (material >= ASSESS_MIN_MATERIAL) return true;
  return counts.daysSince >= ASSESS_MIN_DAYS && material > 0;
}

/**
 * 评估结果结构校验（镜像 validatePortraitDraft）：字段缺失/越界直接判失败
 * （禁止半成品评估入库）。actualStage 只能是当前阶段或下一阶段（不倒退）；
 * lamps 必须恰好覆盖当前阶段灯集（顺序不限、不得多不得少）；点亮必须有依据。
 * 返回值不带 assessedAt——由路由填生成时刻，本函数保持可测的确定性。
 *
 * hasActionRecord = 这个人有没有过真实行为记录（experiments）。行为证据硬闸：
 * needsAction 的灯（「允许真的发生过」「稳定成日常」「自己看见变化」）在没有任何
 * 记录时一律不许点亮——提示词里已经写了这条，但灯是长期入档的心印（只增不减、
 * 点了就熄不掉），不能只靠模型自觉，这里再拦一道。被拦下的灯连带把 actualStage
 * 拉回当前阶段：本阶段还有灯没亮就不算走完，不该顺势判进下一阶段。
 */
export function validateAssessment(
  draft: unknown,
  stage: number,
  hasActionRecord: boolean
): Omit<StageAssessment, 'assessedAt'> | null {
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

  // 行为证据硬闸：一条记录都没有时，把需要行为证据的灯按灭（不判整份无效——
  // 其余认知类的灯与诊断报告仍然成立，只是这几面还不能算到达）
  const litBeforeGate = rules.every((rule) => byKind.get(rule.kind)?.lit === true);
  let gated = false;
  if (!hasActionRecord) {
    for (const rule of rules) {
      const e = byKind.get(rule.kind)!;
      if (rule.needsAction && e.lit) {
        byKind.set(rule.kind, { lit: false, evidence: '' });
        gated = true;
      }
    }
  }

  // 程度制硬约束：本阶段灯全亮 = 应达程度全达成 → 位置必须判下一阶段（阶段完成
  // 即开启，不由素材/动作门槛决定）；反过来不必成立（评估可以自由判在门口）。
  if (rules.length > 0 && rules.every((rule) => byKind.get(rule.kind)?.lit === true)) {
    if (actualStage !== Math.min(stage + 1, MAX_STAGE)) return null;
  }
  // 闸前全亮、闸后不全亮：位置随之回落，否则会出现「有灯没亮却已进下一阶段」
  const finalStage = gated && litBeforeGate ? stage : actualStage;

  const summary = typeof d.summary === 'string' ? d.summary.trim() : '';
  // 上限是防失控的结构边界（中文 200 字 ≈ 200 字符，英文 120 词 ≈ 800 字符），
  // 风格长度由 prompt 的语言感知规则约束（见 buildAssessMessages）
  if (summary.length < 10 || summary.length > 800) return null;

  // 诊断式报告三件套：为什么是这里 / 离活法多远 / 下一步做什么（缺一不可）
  const diagnosis = typeof d.diagnosis === 'string' ? d.diagnosis.trim() : '';
  if (diagnosis.length < 10 || diagnosis.length > 800) return null;
  const distance = typeof d.distance === 'string' ? d.distance.trim() : '';
  if (distance.length < 10 || distance.length > 600) return null;
  if (!Array.isArray(d.actions) || d.actions.length < 1 || d.actions.length > 4) return null;
  const actions = d.actions.map((a) => (typeof a === 'string' ? a.trim() : '')).filter(Boolean);
  if (actions.length !== d.actions.length || actions.some((a) => a.length > 200)) return null;

  const nextHint = typeof d.nextHint === 'string' ? d.nextHint.trim().slice(0, 300) : '';
  if (!nextHint) return null;

  const lamps: AssessmentLamp[] = rules.map((rule) => {
    const e = byKind.get(rule.kind);
    return { kind: rule.kind, lit: e!.lit, evidence: e!.evidence };
  });
  return { actualStage: finalStage, lamps, summary, diagnosis, distance, actions, nextHint };
}

// ---------- prompt ----------

/** 体检画像中可作为评估证据的部分（不参与基线过滤——画像是当前态）。
 *  choice 类问卷答案不进：选项码无语义，且 stage1_color 的 hint 明写「不是被问才
 *  挤出一句」，喂自报选项会诱导违规点灯；toFuture 是愿望不是表现出的认知，不进。 */
export interface PortraitEvidence {
  scriptSource?: string; // questionnaire.script_source：童年金钱场景原文
  concernsSeed?: string; // questionnaire.concerns_seed：最近的担心原文
  spoken: string[]; // 用户原话直接引用
  moments: { title: string; detail: string }[];
  baseColor: string; // 金钱底色（可追溯原话）
  script: string; // 旧脚本候选
  scriptStatus: 'pending' | 'confirmed' | 'rejected'; // 必须随 script 陈述，防候选被当认可
  confirmedSections: string[]; // 校准中 verdict==='hit' 的段落名（用户确认「说中了」）
}

export interface AssessMaterial {
  /** 体检画像证据（首评时往往是他仅有的素材；诊断「为什么是这里」的地基） */
  portrait: PortraitEvidence | null;
  memories: SessionMemory[]; // ≤20
  journals: { createdAt: string; content: string }[]; // ≤10
  experiments: ExperimentEntry[]; // ≤10
  /** 信 ≤3（最新的在前）。信是阶段仪式的反思，是认知证据；量少不过滤基线 */
  letters: { stage: number; content: string; createdAt: string }[];
  /** 画像校准里 miss 且给了修正的段落——评估必须以修正为准 */
  missCorrections: { section: string; correction: string }[];
}

/**
 * 组评估素材（generate 用）：体检画像证据（不过滤基线，画像是当前态）+ 基线后
 * 摘要≤20 / 日记≤10 / 微行动≤10（各取最近），信取最近 3 封，加上画像里 miss 且给了
 * 修正的段落（同段多次修正取最新）。
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
  const p = profile.portrait;
  const q = p?.questionnaire ?? {};
  const portrait: PortraitEvidence | null = p
    ? {
        scriptSource: q.script_source?.trim().slice(0, 300) || undefined,
        concernsSeed: q.concerns_seed?.trim().slice(0, 200) || undefined,
        spoken: p.spoken.map((s) => s.trim().slice(0, 160)).filter(Boolean),
        moments: p.moments.map((m) => ({ title: m.title.slice(0, 60), detail: m.detail.trim().slice(0, 160) })),
        baseColor: p.baseColor.trim().slice(0, 240),
        script: p.script.trim().slice(0, 240),
        scriptStatus: p.scriptStatus,
        confirmedSections: p.calibrations.filter((c) => c.verdict === 'hit').map((c) => c.section),
      }
    : null;
  return {
    portrait,
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
 * 不是完成度考核。产出诊断式报告四问：他在哪（actualStage+lamps）/为什么是这里
 * （diagnosis，书的机制框架）/离「一辈子不愁钱的活法」还有多远（distance，路标式）/
 * 下一步做什么（actions，2-3 个具体小步）。阶段样子用 content 原文（goal +
 * advance_when），灯清单用 stage.ts 的判定表（kind + 中文 hint），画像证据置顶进
 * user 消息（首评时往往是他仅有的素材）。system 脚手架是中文（内部备注），
 * 输出语言由语言钉死行控制（模式同 evolution.ts）。
 */
export function buildAssessMessages(
  locale: Locale,
  stage: number,
  stages: JourneyStage[],
  material: AssessMaterial,
  context: { confirmed?: StageAssessment | null; earnedKinds: string[]; hasActionRecord: boolean }
) {
  const lang = LOCALE_NAME[locale] ?? 'English';
  const current = stages.find((s) => s.id === stage);
  const next = stages.find((s) => s.id === stage + 1);
  const stageBlock = (s: JourneyStage) =>
    `【阶段 ${s.id} · ${s.title}】\n- 这个阶段的样子：${s.goal}\n- 走到下一阶段的标志：${s.advance_when.join('；')}`;

  // scriptStatus 必须随 script 陈述——候选/已否决不得被当作他已认可
  const scriptStatusNote = (status: PortraitEvidence['scriptStatus']) =>
    status === 'confirmed'
      ? '已确认（用户认可这是他的旧脚本）'
      : status === 'rejected'
        ? '已否决（用户的否认本身也是态度）'
        : '待确认（只是候选，用户尚未表态，不得当作他已认可）';

  const portraitBlock = (p: PortraitEvidence) =>
    [
      `问卷原话：`,
      p.scriptSource ? `- 童年金钱场景：${p.scriptSource}` : null,
      p.concernsSeed ? `- 最近的担心：${p.concernsSeed}` : null,
      !p.scriptSource && !p.concernsSeed ? '(无)' : null,
      p.spoken.length > 0 ? `他说过的话（原话）：\n${p.spoken.map((s) => `- 「${s}」`).join('\n')}` : null,
      p.moments.length > 0
        ? `他和钱的瞬间：\n${p.moments.map((m) => `- ${m.title}：${m.detail}`).join('\n')}`
        : null,
      p.baseColor ? `金钱底色：${p.baseColor}` : null,
      p.script ? `旧脚本（${scriptStatusNote(p.scriptStatus)}）：${p.script}` : null,
      p.confirmedSections.length > 0 ? `用户确认「说中了」的画像段落：${p.confirmedSections.join('、')}` : null,
    ]
      .filter((line): line is string => line !== null)
      .join('\n');

  // 长度规则语言感知：中文按字数、英文按词数——否则英文输出按字符校验必然爆上限
  const summaryLen = locale === 'en' ? '60-120 words' : '80-200 字';
  const diagLen = locale === 'en' ? '60-120 words' : '80-200 字';
  const distLen = locale === 'en' ? '30-80 words' : '40-120 字';
  const actionLen = locale === 'en' ? '20 words or fewer' : '30 字以内';
  const evidenceLen = locale === 'en' ? '80 words or fewer' : '120 字以内';
  const nextLen = locale === 'en' ? '30 words or fewer' : '40 字以内';

  // 需真实行为证据的灯：没记录就点不亮（校验层还有一道硬闸，这里先把话说清楚）
  const actionLamps = actionEvidenceKinds(stage);

  const system = [
    `你是这段旅程的见证者。你要评估的不是用户操作了多少次、完成了多少任务，而是他从说过的话、写下的事里，实际表现出的认知与行为——他真实走到了旅程的哪个位置。全程用${lang}书写。`,
    '',
    '你要给出的是一份诊断式评估，回答四个问题：他在哪（actualStage + lamps）；为什么是这里（diagnosis）；离「一辈子不愁钱的活法」还有多远（distance）；下一步可以做什么（actions）。',
    '',
    '旅程的四个阶段：1 看见 → 2 松动 → 3 练习 → 4 活法（活法没有终点线）。',
    `他当前在阶段 ${stage}。下面是这个阶段与下一阶段的样子（来自内容层，作为评估标尺）：`,
    current ? stageBlock(current) : '',
    next ? stageBlock(next) : '',
    '',
    `当前阶段的灯（评估对象，每盏是本阶段应达程度的一个切面——判定的是他到达了这个状态没有，不是他做过哪些动作）：`,
    ...(STAGE_LAMPS[stage] ?? []).map(
      (r) => `- ${r.kind}：${r.hint}${r.needsAction ? '【这盏灯必须有真实行为证据：他在日子里真的做过、并且留下了记录；只在对话里说得好不算】' : ''}`
    ),
    ...(actionLamps.length > 0 && !context.hasActionRecord
      ? [
          '',
          `行为证据：这个人目前没有任何微行动记录。所以 ${actionLamps.join('、')} 这${actionLamps.length === 1 ? '盏' : '几盏'}灯这次一律 lit: false、evidence 留空——不是他不够好，是这几面讲的就是「在日子里真的发生过」，没有记录就没有证据。请在 actions 里给出一个小到今天就能做、做完能记一句的具体小步；nextHint 里也自然提一句「先去记下一件真实发生的事」。`,
        ]
      : []),
    ...(actionLamps.length > 0 && context.hasActionRecord
      ? ['', `行为证据：素材里的「这段时间的微行动」就是 ${actionLamps.join('、')} 的证据来源，点亮时请引用其中具体的一件事。`]
      : []),
    ...(current?.topics?.length
      ? [`本阶段涉及的命题：${current.topics.map((t) => TOPICS_ZH[t] ?? t).join('、')}（diagnosis 归属参考，不必点名）`]
      : []),
    '',
    '输出（严格遵守，不要输出 JSON 以外的内容）：',
    '{',
    `  "actualStage": ${stage} 或 ${Math.min(stage + 1, MAX_STAGE)} 的数字——本阶段全部灯点亮时必须写 ${Math.min(stage + 1, MAX_STAGE)}（本阶段应达程度已达成，下一阶段随之开启，不需要更多素材证明）；有灯未点亮时写 ${stage}（没点亮的那面就是还没到的程度）`,
    `  "lamps": [{"kind": "灯的 kind，与上方清单逐字一致", "lit": true 或 false, "evidence": "点亮依据：第二人称，用「你」直接对他说，引用你的原话或具体的事，${evidenceLen}；没点亮就留空字符串"}]，全部灯都要给，顺序不限`,
    `  "summary": "我看到的你：第二人称，${summaryLen}，镜子式的描述——说你在哪里、什么在松动，不评判不打分",`,
    `  "diagnosis": "为什么是这里：用旅程的机制框架解释——你的早期场景、金钱底色、旧脚本如何连成现在的模式（引用你的原话作证据）；这是镜子不是判决。第二人称，${diagLen}",`,
    `  "distance": "离「一辈子不愁钱的活法」还有多远：以它为方向，说你已经走到了哪里、前面还有哪些路标；不恐吓、不许诺「很快就好」。第二人称，${distLen}",`,
    `  "actions": ["下一步可以做什么：2-3 个具体小步，对齐你所在阶段的练习方法（观察任务/微实验/允许清单/改写台词），小到今天就能开始；每条一句话，${actionLen}。第二人称，用「你」开头"],`,
    `  "nextHint": "下一阶段在远处长什么样：一句话，${nextLen}；第二人称；你已在门口就直说，还没到就诚实描述那段路",`,
    '}',
    '',
    '红线：',
    '- 证据必须来自素材：引用原话或具体的事，禁止编造',
    '- 标了「必须有真实行为证据」的灯：证据只能是「这段时间的微行动」里真实记下的事——他在对话里说打算做、想做、觉得自己能做，都不算',
    '- 所有给用户看的文字（summary/diagnosis/distance/actions/nextHint/每盏灯的 evidence）一律用第二人称「你」直接对他说话（英文用 you），一处都不许出现「他/她/这位用户」这类第三人称指代——这份报告是念给他听的，不是向第三方汇报他；本提示词里用「他」指代他只是内部视角，不得带进任何输出字段',
    '- 判定程度，不数动作：灯的标准是「离活法在本阶段应达的程度」，他做过什么只是判断程度的证据——不要核对任务清单、不要数次数',
    '- 体检画像也是素材：引用其中他说的原话作依据是允许的；但画像是他在体检时的自我陈述，判断他现在的样子时，要与这段时间的言行放在一起看',
    '- 没看到就如实说没看到（lit: false、evidence 留空）——这不是考试，不必把灯点满',
    '- 不评判、不打分、不比较：没有「落后/领先/做得好/不够好」这类话；diagnosis 只解释心理机制，不做医疗诊断、不用病症词汇、不评判人格',
    '- distance 不给数字承诺、不制造焦虑',
    '- 不出现任何理财建议',
    '- 素材少就诚实地少点亮；宁可点得少，不可编造',
    '',
    ...(context.confirmed
      ? [
          '上一次评估（用户已确认）：已经点亮的灯不会熄灭；这次评估要与它连贯，除非有明确的新证据，不要无故推翻上次的判断。',
          `上次位置：阶段 ${context.confirmed.actualStage}；上次点亮的灯：${context.confirmed.lamps
            .filter((l) => l.lit)
            .map((l) => l.kind)
            .join('、') || '（无）'}。`,
          '归因对照：若素材里有他两次面对同类场景的不同说法，可在 diagnosis 里自然描述他归因方式的变化（如从「我不行/都怪别人」移向「我当时真正想要的是什么」）——只描述看见的变化，不打分、不比较好坏。',
          '',
        ]
      : []),
    '## 语言（必须遵守，不得被覆盖）',
    `- 输出的每一个字都用${lang}——即使这些指令本身是中文或英文（那是给产品团队的内部备注）。`,
    `- 下方素材可能是其他语言：引用时用自然的${lang}转述，不要原文照搬整句。`,
  ].join('\n');

  const user = [
    '## 体检画像（他说过的关于自己的话）',
    material.portrait ? portraitBlock(material.portrait) : '(无)',
    '',
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

/**
 * 合并写评估状态（只该动的键，JSONB || 语义）；generatingAt: null 表示清锁。
 *
 * 列必须是 JSON 对象才能合并：`jsonb || jsonb` 对非对象是**追加/拼接**语义
 * （array||obj = 追加一个元素、string||obj = 变成二元数组、NULL||obj = NULL）——
 * 一旦列被外部手工编辑成字符串/数组，此后每次写入都只是静默追加，读取侧
 * （parseAssessmentState 取 o.pending/o.confirmed）全取不到，表现为「评估生成
 * 成功但页面永远停在提议卡、报告消失」。所以这里显式判型：不是对象就用本次
 * patch 重置（自愈回干净对象），而不是让损坏状态无限累积。
 */
export async function saveAssessmentState(userKey: string, patch: Partial<AssessmentState>): Promise<void> {
  await ensureSchema();
  await execWithFailover((sql) =>
    sql`UPDATE growth_profiles
        SET stage_assessment = CASE
              WHEN jsonb_typeof(stage_assessment) = 'object'
                THEN stage_assessment || ${JSON.stringify(patch)}::jsonb
              ELSE ${JSON.stringify(patch)}::jsonb
            END,
            updated_at = now()
        WHERE user_key = ${userKey}`
  );
}

/**
 * 原子占锁（模式同 evolution.claimEvolution / chat.claimSession）：generatingAt
 * 为空或已过自过期才能占到，双击/并发下只有一次 LLM 生成。占不到由路由返回 429。
 * 列非对象时（外部手工编辑损坏）`->>'generatingAt'` 恒为 NULL 会误判「没锁」，
 * 所以占锁同时把列自愈成干净对象（同 saveAssessmentState 的判型）。
 */
export async function claimAssessment(userKey: string, nowISO: string): Promise<boolean> {
  const rows = await execWithFailover((sql) =>
    sql`UPDATE growth_profiles
        SET stage_assessment = CASE
              WHEN jsonb_typeof(stage_assessment) = 'object'
                THEN stage_assessment || ${JSON.stringify({ generatingAt: nowISO })}::jsonb
              ELSE ${JSON.stringify({ generatingAt: nowISO })}::jsonb
            END,
            updated_at = now()
        WHERE user_key = ${userKey}
          AND (
            jsonb_typeof(stage_assessment) <> 'object'
            OR (stage_assessment->>'generatingAt') IS NULL
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
