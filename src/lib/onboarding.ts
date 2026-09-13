// 体检流程业务层：问卷定义、初谈/确认/画像的 prompt 组装与输出校验。
// prompt 原料来自 content/{locale}/journey/1-看见.md（阶段正文 + ai_stance）——
// 内容层改动即生效，这里不做任何文案硬编码（除 JSON 结构指令）。
import { getJourneyStage, getPracticesForStage } from '@/lib/content';
import type { Portrait } from '@/lib/profile';
import type { Locale } from '@/i18n/config';

// ---------- 问卷（docs/02 §2①：收集具体的事，不是量表分数） ----------

export interface QuestionDef {
  id: 'moment_when' | 'balance_feeling' | 'childhood' | 'payday_action' | 'aspiration' | 'recent_worry';
  /** choice=四选一，free=开放题 */
  kind: 'choice' | 'free';
  /** choice 题的选项值（文案在 messages.onboarding.questions.<id>.options） */
  options?: string[];
  /** 进档案的字段（portrait.questionnaire 的键） */
  field: string;
}

export const QUESTIONS: QuestionDef[] = [
  { id: 'moment_when', kind: 'choice', options: ['week', 'month', 'cant_remember', 'dare_not'], field: 'specific_moments' },
  { id: 'balance_feeling', kind: 'choice', options: ['calm', 'avoid', 'panic', 'whatever'], field: 'money_feeling' },
  { id: 'childhood', kind: 'free', field: 'script_source' },
  { id: 'payday_action', kind: 'choice', options: ['repay', 'save', 'treat', 'nothing'], field: 'payday_habit' },
  { id: 'aspiration', kind: 'choice', options: ['relaxed', 'dare_spend', 'earn_well', 'free_of_money'], field: 'aspiration' },
  { id: 'recent_worry', kind: 'free', field: 'concerns_seed' },
];

/** 问卷答案 → 档案 payday 结构（Q4 只反映习惯，锚点本体走 Q7 可跳过；MVP 不猜默认） */
export function paydayFromAnswers(_answers: Record<string, string>): null {
  // 默认不猜：发薪日锚点由用户在 /me 主动设置（各国发薪日不同，猜"月底"=「它不懂我」）
  return null;
}

// ---------- prompt 组装 ----------

export const LOCALE_NAME: Record<string, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  ja: '日本語',
};

/** 初谈 system：阶段 1 姿态（内容层）+ 初谈专用纪律 + 问卷素材 */
export function buildTalkSystem(locale: Locale, questionnaire: Record<string, string>): string {
  const stage = getJourneyStage(locale, 1);
  const practices = getPracticesForStage(1);
  const lines: string[] = [];

  lines.push(`你是一位温和的陪伴者，正在和用户做「金钱关系体检」的初谈。请始终用${LOCALE_NAME[locale] ?? 'English'}回复。`);
  if (stage) {
    lines.push('', '## 这个阶段的引导原则（必须遵守）', stage.body);
    lines.push('', '本阶段 AI 姿态：', ...stage.ai_stance.do.map((d) => `- DO: ${d}`), ...stage.ai_stance.dont.map((d) => `- DON'T: ${d}`));
  }
  if (practices.length > 0) {
    lines.push('', '## 创造者的实践经验（转述时标注为创造者观点，不是你的话）');
    for (const p of practices) lines.push(`[${p.date}] ${p.body}`);
  }

  lines.push(
    '',
    '## 初谈规则（与阶段原则叠加，冲突时以这里更严格的为准）',
    '- 你只有 3-5 轮机会。第一轮：从问卷答案里挑情绪重量最重的一处，用 1-2 句话接住情绪 + 一个具体的追问开场。',
    '- 每轮只追问一个点，往深处走（什么时候、当时发生了什么、心里什么感觉），绝不换话题、绝不问清单式问题。',
    '- 全程不给建议、不安慰、不纠正、不总结——只反映和好奇。',
    '- 把用户原话里最生动的一句原样复述回去（这是「被听见」的来源）。',
    '- 用户明显不适时，放慢并说明可以随时停。不要为了流程推进而推进。',
  );

  lines.push('', '## 用户问卷答案（原始素材，禁止当作已确认的事实转述给用户）');
  for (const q of QUESTIONS) {
    const v = questionnaire[q.field];
    if (v) lines.push(`- ${q.id}: ${v}`);
  }
  return lines.join('\n');
}

/** 「我听到的是」确认：3-5 句复述，供用户确认/补充（素材校验，不是总结陈词） */
export function buildReflectMessages(
  locale: Locale,
  chatText: string
): { system: string; messages: { role: 'user' | 'assistant'; content: string }[] } {
  const opener =
    locale === 'en'
      ? 'What I heard is…'
      : locale === 'ja'
        ? '私が聞いたのは…'
        : locale === 'zh-TW'
          ? '我聽到的是…'
          : '我听到的是…';
  return {
    system: [
      `你是初谈的倾听者。初谈结束前，用 3-5 句话向用户复述你听到的关键点（「${opener}」）。请始终用${LOCALE_NAME[locale] ?? 'English'}输出。`,
      `规则：只复述用户真的说过的内容，以「${opener}」开头；拿不准的地方用问句结尾（「我理解得对吗」）；`,
      '不做评价、不建议、不升华。直接输出这 3-5 句话本身，不要任何前后缀。',
    ].join('\n'),
    messages: [{ role: 'user', content: `以下是我和你初谈的记录：\n\n${chatText}\n\n请输出「${opener}」。` }],
  };
}

// ---------- 画像生成 ----------

export interface PortraitDraft {
  spoken: string[];
  baseColor: string;
  moments: { title: string; detail: string }[];
  script: string;
  toFuture: string;
}

/** 画像生成：一次性产出四段 + 脚本候选。素材不足宁少写、禁止编造（docs/02 §2②） */
export function buildPortraitMessages(locale: Locale, questionnaire: Record<string, string>, chatText: string) {
  const lang = LOCALE_NAME[locale] ?? 'English';
  const system = [
    `你是金钱画像的绘制者。根据用户的问卷答案与初谈记录，产出画像 JSON。全程用${lang}书写。`,
    '',
    '结构（严格遵守，不要输出 JSON 以外的内容）：',
    '{',
    '  "spoken": ["用户原话的直接引用，2-4 条；不足则有几条写几条，禁止编造或润色成书面语"],',
    '  "baseColor": "金钱底色：第二人称、100-200 字，围绕 spoken 里的原话展开。每句话必须能追溯到用户说过的话，禁止空泛性格标签（如 你是个追求完美的人）",',
    '  "moments": [{"title": "瞬间短标题", "detail": "1-2 句具体场景"}],',
    '  "script": "我听到的可能：一条旧脚本候选，必须以 也许/可能 类措辞开头，30 字以内，像一句用户心里的旧规矩",',
    '  "toFuture": "给未来的你：一句话，温和、不承诺结果",',
    '  "moments_note": "moments 取 1-3 个具体场景（问卷+初谈里的时间地点事件），不足 3 个就写几个"',
    '}',
    '',
    '红线：',
    '- 不够素材的地方宁可少写，禁止编造（画像里没有的内容不出现）',
    '- spoken 只引用用户问卷/初谈里的原话片段，不改写',
    '- script 最多一条；用「也许」「可能」，禁止断言',
    '- 不出现任何理财建议、诊断、病症词汇',
  ].join('\n');

  const user = [
    '## 问卷答案',
    ...QUESTIONS.map((q) => {
      const v = questionnaire[q.field];
      return `- ${q.id}: ${v ?? '(未答)'}`;
    }),
    '',
    '## 初谈记录',
    chatText || '(初谈被跳过)',
  ].join('\n');

  return { system, messages: [{ role: 'user' as const, content: user }] };
}

/** 画像草稿结构校验：字段缺失/越界直接判失败（禁止半成品画像入库） */
export function validatePortraitDraft(draft: unknown): PortraitDraft | null {
  if (typeof draft !== 'object' || draft === null) return null;
  const d = draft as Record<string, unknown>;
  const spoken = Array.isArray(d.spoken) ? d.spoken.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : [];
  if (spoken.length === 0) return null;
  if (typeof d.baseColor !== 'string' || d.baseColor.trim().length < 30) return null;
  const moments = Array.isArray(d.moments)
    ? d.moments
        .filter((m): m is { title: string; detail: string } => {
          if (typeof m !== 'object' || m === null) return false;
          const mm = m as Record<string, unknown>;
          return typeof mm.title === 'string' && typeof mm.detail === 'string';
        })
        .map((m) => ({ title: m.title.trim(), detail: m.detail.trim() }))
        .filter((m) => m.title && m.detail)
    : [];
  if (moments.length === 0) return null;
  if (typeof d.script !== 'string' || d.script.trim().length === 0) return null;
  if (typeof d.toFuture !== 'string' || d.toFuture.trim().length === 0) return null;
  return {
    spoken: spoken.map((s) => s.trim()).slice(0, 4),
    baseColor: d.baseColor.trim(),
    moments: moments.slice(0, 3),
    script: d.script.trim(),
    toFuture: d.toFuture.trim(),
  };
}

// ---------- 校准（docs/02 §2⑤：说中了 / 不太像 + 可选修正，写回档案） ----------

export type CalibrateSection = 'script' | 'baseColor' | 'toFuture' | `spoken:${number}` | `moment:${number}`;
export type CalibrateVerdict = 'hit' | 'miss';

export function parseCalibrateSection(value: string): CalibrateSection | null {
  if (['script', 'baseColor', 'toFuture'].includes(value)) return value as CalibrateSection;
  const m = value.match(/^(spoken|moment):(\d+)$/);
  if (!m) return null;
  const index = Number(m[2]);
  if (!Number.isInteger(index) || index < 0 || index > 9) return null;
  return `${m[1]}:${index}` as CalibrateSection;
}

/**
 * 校准写回（纯函数，返回新画像；不合法返回 null 由路由报 400）：
 * - hit：脚本确认（confirmed 后才进 AI 长期工作记忆，docs/02 §3）
 * - miss：该段内容 AI 不再使用——无修正则删除该条（spoken/moments 有弹性），
 *   有修正则替换为用户的话；script 特殊：miss → rejected（保留原文但标记不用）
 */
export function applyCalibration(
  portrait: Portrait,
  section: CalibrateSection,
  verdict: CalibrateVerdict,
  correction?: string,
): Portrait | null {
  const next: Portrait = {
    ...portrait,
    calibrations: [...portrait.calibrations, { section, verdict, correction, at: new Date().toISOString() }],
  };
  const fixed = correction?.trim();

  if (section === 'script') {
    if (verdict === 'hit') {
      next.scriptStatus = 'confirmed';
    } else {
      next.scriptStatus = 'rejected';
      if (fixed) next.script = fixed; // 用户给出更像的说法，替换候选
    }
    return next;
  }

  if (section === 'baseColor' || section === 'toFuture') {
    if (verdict === 'hit') return next;
    if (!fixed) return null; // 这两段不允许空删，必须给出修正
    if (section === 'baseColor') next.baseColor = fixed;
    else next.toFuture = fixed;
    return next;
  }

  const [kind, rawIndex] = section.split(':');
  const index = Number(rawIndex);
  if (kind === 'spoken') {
    if (index >= next.spoken.length) return null;
    if (verdict === 'miss' && !fixed) next.spoken = next.spoken.filter((_, i) => i !== index);
    else if (fixed) next.spoken = next.spoken.map((s, i) => (i === index ? fixed : s));
    return next;
  }
  // moment:<i>
  if (index >= next.moments.length) return null;
  if (verdict === 'miss' && !fixed) next.moments = next.moments.filter((_, i) => i !== index);
  else if (fixed) next.moments = next.moments.map((m, i) => (i === index ? { ...m, detail: fixed } : m));
  return next;
}
