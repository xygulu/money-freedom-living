// 陪伴者「有话要说」文案生成（前台改造 §6）。
//
// 用户纠偏后的语义：nudge 不是"今天这一步你还没做"那样的行动催促，
// 也不是理财建议，而是 AI 通过对用户历史的理解、和当前阶段的成长目标，
// 自动生成的内容，希望给用户带来成长帮助。
//
// 混合策略（L1 模板优先 → L2 LLM 降级 → L3 兜底）：
//   L1a 引用最近一条 memory（用户自己的原话）
//   L1b 引用当前阶段 goal（书的方向，不评价）
//   L1c 引用最近一条 promise/open concern/last letter（"你说想试的那件事"）
//   L1d 引用自己的日历（发薪日 / 月末 / 大促）——§6 三种合法触发②
//   L2  LLM 降级——只在 L1 四档全空 + 用户已有 ≥1 段实质素材时调用
//   L3  兜底空模板——dict.nudge.fallback（"我在这儿。"）
//
// 红线（hitRedLine）：
//   - 完成度指责：没完成 / 还差 / 还剩 / 完成度 / 未完成
//     **例外（用户 2026-09-14 在 §6 拍板保留）**：球的"有话要说"可以用
//     「今天这一步你还没做」作为**唯一的完成度陈述**——见 CompanionChat
//     hintToday 模式（chatMode.hintToday / hintBubble.hintToday）；红线条目里
//     不再挡 `/还没做/` `/今天你还没/` `/你还没/`，挡 LLM 输出就够了。
//   - 产品机制：连续…天 / 排行 / 成就 / 徽标 / 积分 / 红点 / 倒计时 / 阶段灯 / 深度报告 / 参考节奏 / 四个阶段
//   - 静态引用：书名 / 理财建议（收益率 / 复利 / 年化 / 资产配置）
//
// 频次闸（外部控制，不在本模块）：cookie `mfl_nudge_seen` 24h 内不重；
// 本地 `localStorage.mfl_nudge_dismissed` 当日 dismissed 不重。
// 路由侧还要先过 safety 闸（crisis/DV → 不展示），本模块提供 safetyBlocked 入参，
// 命中时直接走 L3 兜底。
import { llmComplete } from '@/lib/llm';
import type { Locale } from '@/i18n/config';

export type NudgeSource =
  | 'template-memory'
  | 'template-goal'
  | 'template-promise'
  | 'template-anchor'
  | 'llm'
  | 'fallback';

/** §6 L1d 触发：日历（发薪日 / 月末 / 大促等）——调用方把判断结果传入。 */
export type AnchorKind = 'payday' | 'month_end' | 'sale' | null;

export interface CompanionNudgeInput {
  locale: Locale;
  /** 最近一条 memory 摘要（用户自己的原话，≥1 句） */
  lastMemoryText?: string | null;
  /** 当前阶段的 goal（书的阶段目标，可为 null） */
  stageGoal?: string | null;
  /** 最近一条"想试/承诺/未完成" ——promise/open concern/last letter 内容都可入 */
  lastTouchedPrompt?: string | null;
  /**
   * §6 L1d：今天是不是日历上他自己的日子（发薪日 / 月末 / 大促）。
   * 命中时 L1d 模板拼出"今天是你设的锚点日"——这是用户自己定的日子，不算完成度指责。
   */
  anchorKind?: AnchorKind;
  /** safety 命中闸（crisis/DV → 直接走兜底，不调 LLM） */
  safetyBlocked?: boolean;
  /** LLM 注入点（默认 llmComplete）；测试可替成 stub */
  llmFn?: (opts: { system: string; user: string; maxTokens: number; temperature: number }) => Promise<string | null>;
  /** L3 兜底文案（来自 dict.nudge.fallback） */
  fallback: string;
  /** LLM 跳过开关：测试用 */
  allowLlm?: boolean;
}

export interface CompanionNudgeOutput {
  text: string;
  source: NudgeSource;
  hitRedLine: boolean;
  /** 被截断的红线命中点（debug 用，不入 UI） */
  redLineMatches?: string[];
}

/**
 * 红线正则（70-2 §6 用户纠偏版）：
 * - 不得出现完成度指责：没完成 / 还差 / 还剩 / 完成度 / 未完成
 *   **§6 例外**（用户 2026-09-14 拍板保留）：球的"有话要说"**唯一例外**允许出现
 *   「今天这一步你还没做」——这是球在 `todayStepDone=true` 且 nudge 命中时由
 *   CompanionChat hintToday 模式**固定拼出的**四件套文案（chatMode.hintToday +
 *   hintBubble.hintToday），不进 nudge 文案生成器、不进 LLM。
 *   因此：① 红线不再挡 `/还没做/` `/今天你还没/` `/你还没/`（避免误禁 hintToday 文案）；
 *   ② LLM system prompt 仍显式禁完成度指责（见 TEMPLATES[*].llmSystem）；③ 其他完成度
 *   指责仍被挡（没完成 / 还差 / 还剩 / 完成度 / 未完成）。
 * - 不得出现产品机制（首页红线 D4）：连续…天 / 排行 / 成就 / 徽标 / 积分 / 红点 /
 *   倒计时 / 阶段灯 / 深度报告 / 参考节奏 / 四个阶段 / 进度
 * - 不得出现书名 / 理财建议：收益率 / 复利 / 年化 / 资产配置 / 理财建议 / 投资标的
 *
 * 红线只挡"显示给用户的 nudge 文案"。模板内容（L1a/L1b/L1c/L1d）由本模块自己拼接，
 * 永远不过红线；LLM 输出（L2）过一次，命中即降级 L3。
 */
export const RED_LINE_PATTERNS: readonly RegExp[] = [
  // 完成度指责（保留；§6 例外文案由模板拼出，不经过此函数）
  /没完成/,
  /还差/,
  /还剩/,
  /完成度/,
  /未完成/,
  // 产品机制（首页红线 D4）
  /连续\d+天/,
  /连续.+?天/,
  /排行/,
  /成就/,
  /徽标/,
  /积分/,
  /红点/,
  /倒计时/,
  /阶段灯/,
  /深度报告/,
  /参考节奏/,
  /四个阶段/,
  /进度条/,
  /完成率/,
  // 静态引用（书名 / 理财建议）
  /一辈子不愁钱的活法/,
  /一辈子不愁钱/,
  /收益率/,
  /复利/,
  /年化/,
  /资产配置/,
  /理财建议/,
  /投资标的/,
];

/** 单条文案是否撞红线；返回 true 即不应展示给用户 */
export function hitRedLine(text: string): boolean {
  return RED_LINE_PATTERNS.some((re) => re.test(text));
}

/** 返回撞了哪几条（仅 debug / 日志使用，不入 UI） */
export function findRedLineMatches(text: string): string[] {
  const hits: string[] = [];
  for (const re of RED_LINE_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}

/**
 * 截一段用户原话引用（避免长 memory 把 nudge 撑爆）。
 * 中文按字符、英文按词大致截断——展示给用户的引用长度上限。
 */
function clipQuote(text: string, maxChars = 36): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars - 1) + '…';
}

// ---- 模板拼接器（每语一个） ----

interface NudgeTemplates {
  memory: (quote: string) => string;
  goal: (goal: string) => string;
  promise: () => string;
  anchor: (kind: NonNullable<AnchorKind>) => string;
  llmSystem: string;
}

const TEMPLATES: Record<Locale, NudgeTemplates> = {
  en: {
    memory: (q) => `You said "${clipQuote(q)}" last time — still around this week?`,
    goal: (g) => `This stage's question is: ${clipQuote(g, 80)}. No rush — just look when you can.`,
    promise: () => `The thing you said you wanted to try — do you still remember?`,
    anchor: (kind) => {
      if (kind === 'payday') return `Today is the anchor day you set (payday). How did you and money get along this stretch?`;
      if (kind === 'month_end') return `It's month-end — your anchor day. Any settle-down you'd like to do today?`;
      return `It's the anchor day you set. Anything you'd like to settle today?`;
    },
    llmSystem: `You are the companion in "money-freedom-living". Write ONE short nudge (1-2 sentences, ≤ 140 chars total) the companion would say to one specific person right now.

Hard rules — output is silently rejected if any matches:
- NEVER use completion-shame language: "haven't done", "not finished", "still need", "didn't complete", "completion rate", or any phrasing that judges them for what they didn't do.
- NEVER use product-mechanism language: "streak", "ranking", "achievement", "badge", "points", "red dot", "countdown", "stage lamp", "deep report", "reference pace", "four stages", "progress bar".
- NEVER mention the book title, financial terms (yield / compounding / annualized return / asset allocation / investment), or give financial advice.
- This is growth-helping content based on the user's own history + current stage goal — NOT a prompt to complete a product action.
- Speak in second person ("you"), no evaluation, no advice, no follow-up question.
- Output ONLY the nudge text — no quotes, no prefix, no JSON, no markdown.`,
  },
  'zh-CN': {
    memory: (q) => `上次你说「${clipQuote(q)}」—— 这一周它在不在？`,
    goal: (g) => `这个阶段的题是：${clipQuote(g, 60)}。今天不一定做，慢慢看。`,
    promise: () => `你说想试的那件事，还记得吗？`,
    anchor: (kind) => {
      if (kind === 'payday') return `今天是你自己设的锚点日（发薪日）。这一段，你和钱处得怎么样？`;
      if (kind === 'month_end') return `今天月末——你自己的锚点日。想停一下、整理一下吗？`;
      return `今天是你自己设的锚点日。有什么想顺手收一收的吗？`;
    },
    llmSystem: `你是「一辈子不愁钱的活法」的陪伴者。现在写一句陪伴者会说的 nudge（1-2 句，总字数 ≤ 80 字）。

硬性红线（命中即作废，不展示）：
- 绝不许出现完成度指责：「还没做 / 没完成 / 还差 / 还剩 / 今天你还没 / 完成度 / 你怎么还没」等。
- 不得出现产品机制词：「连续 X 天 / 排行 / 成就 / 徽标 / 积分 / 红点 / 倒计时 / 阶段灯 / 深度报告 / 参考节奏 / 四个阶段 / 进度条」。
- 不得出现书名「一辈子不愁钱的活法 / 一辈子不愁钱」，也不得出现理财建议（收益率 / 复利 / 年化 / 资产配置 / 投资标的）。
- 这是基于用户历史与当前阶段目标的"成长帮助"内容，不是催促他完成产品动作。
- 第二人称「你」，不评价、不建议、不追问。
- 只输出文案本身——不要加引号、不要前缀、不要 JSON 包裹、不要 markdown。`,
  },
  'zh-TW': {
    memory: (q) => `上次你說「${clipQuote(q)}」—— 這週它在不在？`,
    goal: (g) => `這個階段的題是：${clipQuote(g, 60)}。今天不一定做，慢慢看。`,
    promise: () => `你說想試的那件事，還記得嗎？`,
    anchor: (kind) => {
      if (kind === 'payday') return `今天是你自己設的錨點日（發薪日）。這一段，你和錢處得怎麼樣？`;
      if (kind === 'month_end') return `今天月末——你自己的錨點日。想停一下、整理一下嗎？`;
      return `今天是你自己設的錨點日。有什麼想順手收一收的嗎？`;
    },
    llmSystem: `你是「一輩子不愁錢的活法」的陪伴者。現在寫一句陪伴者會說的 nudge（1-2 句，總字數 ≤ 80 字）。

硬性紅線（命中即作廢，不展示）：
- 絕不許出現完成度指責：「還沒做 / 沒完成 / 還差 / 還剩 / 今天你還沒 / 完成度 / 你怎麼還沒」等。
- 不得出現產品機制詞：「連續 X 天 / 排行 / 成就 / 徽標 / 積分 / 紅點 / 倒計時 / 階段燈 / 深度報告 / 參考節奏 / 四個階段 / 進度條」。
- 不得出現書名「一輩子不愁錢的活法 / 一輩子不愁錢」，也不得出現理財建議（收益率 / 複利 / 年化 / 資產配置 / 投資標的）。
- 這是基於用戶歷史與當前階段目標的「成長幫助」內容，不是催促他完成產品動作。
- 第二人稱「你」，不評價、不建議、不追問。
- 只輸出文案本身——不要加引號、不要前綴、不要 JSON 包裹、不要 markdown。`,
  },
  ja: {
    memory: (q) => `前回「${clipQuote(q)}」と言っていましたね——今週もありますか？`,
    goal: (g) => `このフェーズの問いは：${clipQuote(g, 60)}。今日はやらなくていい、ぼんやり眺めるだけで。`,
    promise: () => `やってみたいと言っていたこと、まだ覚えていますか？`,
    anchor: (kind) => {
      if (kind === 'payday') return `今日はあなたが設定したアンカーの日（給料日）です。この一区間、お金とはどう過ごせましたか？`;
      if (kind === 'month_end') return `今日は月末——あなたのアンカーの日です。立ち止まって、整理してみますか？`;
      return `今日はあなたが設定したアンカーの日です。何か手をつけたいことはありますか？`;
    },
    llmSystem: `あなたは「一生お金に困らない生き方」のコンパニオンです。今この瞬間に言う nudge を 1-2 文（合計 ≤ 140 字）で書いてください。

ハードレッドライン（該当したら出力を捨てます）：
- 完了度責め：「まだやってない / 終わってない / あと X / 完了率」などは絶対禁止。
- プロダクト機構語：「連続 X 日 / ランキング / アチーブメント / バッジ / ポイント / 赤丸 / カウントダウン / 段階ランプ / ディープレポート / 目安ペース / 4 つの段階 / プログレスバー」禁止。
- 書名「一生お金に困らない生き方 / 一生お金に困らない」、投資用語（利回り / 複利 / 年率 / アセットアロケーション / 投資対象）、金融アドバイス禁止。
- ユーザー自身の履歴と今のフェーズの目標に基づく「成長に資する」内容で、製品アクションを促すものではありません。
- 二人称「あなた」。評価・助言・追加の質問はしない。
- 出力は本文のみ——引用符も接頭辞も JSON も markdown も付けない。`,
  },
};

/** 把 LLM 输出整理成可展示的 nudge 文本（去前后空白 / 引号包裹 / 围栏） */
function cleanLlmOutput(raw: string): string {
  let text = raw.trim();
  // 去掉 markdown 围栏（```...```）
  text = text.replace(/^```(?:json|markdown)?\s*/i, '').replace(/```\s*$/, '');
  // 去掉首尾成对引号（AI 偶尔会把整句加引号）
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('「') && text.endsWith('」'))) {
    text = text.slice(1, -1).trim();
  }
  // 截到第一个换行（多段就只取首段）
  text = text.split(/\r?\n/)[0].trim();
  return text;
}

/**
 * LLM 调用包装：允许测试注入；默认走 lib/llm 的 llmComplete。
 * 返回 null 表示 LLM 失败/不可用，调用方应降级到 fallback。
 */
async function defaultLlm(
  opts: { system: string; user: string; maxTokens: number; temperature: number }
): Promise<string | null> {
  try {
    return await llmComplete({
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
    });
  } catch {
    return null;
  }
}

/**
 * 主入口：依优先级返回一条 nudge。
 *   1. safetyBlocked → 直接 L3 兜底（不调 LLM）
 *   2. lastMemoryText → L1a 模板（命中即返回，hitRedLine=false）
 *   3. stageGoal → L1b 模板
 *   4. lastTouchedPrompt → L1c 模板
 *   5. anchorKind → L1d 模板（§6 三种合法触发② 日历）
 *   6. allowLlm && 用户有"实质素材" → L2 LLM（输出过红线，过线降级 L3）
 *   7. fallback → L3 兜底
 *
 * 实质素材判断：lastMemoryText / stageGoal / lastTouchedPrompt / anchorKind 任意一项非空。
 * （L1 四档是命中式返回 → L1 全空 = 用户零素材 → 不值得调 LLM）
 */
export async function buildCompanionNudge(input: CompanionNudgeInput): Promise<CompanionNudgeOutput> {
  const tpl = TEMPLATES[input.locale] ?? TEMPLATES.en;

  // 频次/安全闸：safetyBlocked → 直接兜底，不调 LLM（nudge 拒绝展示）
  if (input.safetyBlocked) {
    return { text: input.fallback, source: 'fallback', hitRedLine: false };
  }

  // L1a：引用最近一条 memory（用户自己的原话）
  if (input.lastMemoryText && input.lastMemoryText.trim()) {
    return { text: tpl.memory(input.lastMemoryText), source: 'template-memory', hitRedLine: false };
  }

  // L1b：引用当前阶段 goal
  if (input.stageGoal && input.stageGoal.trim()) {
    return { text: tpl.goal(input.stageGoal), source: 'template-goal', hitRedLine: false };
  }

  // L1c：引用最近一条 promise/open/last letter 内容（"你说想试的那件事"）
  if (input.lastTouchedPrompt && input.lastTouchedPrompt.trim()) {
    return { text: tpl.promise(), source: 'template-promise', hitRedLine: false };
  }

  // L1d：§6 三种合法触发② —— 用户自己设的日历（发薪日 / 月末 / 大促）
  // 这是用户自己定的日子，不是我们催他做什么——所以优先级低于 a/b/c（"他记得他自己"重于
  // "日历提醒"），又高于 LLM 兜底（避免 LLM 凭空编）。
  if (input.anchorKind) {
    return { text: tpl.anchor(input.anchorKind), source: 'template-anchor', hitRedLine: false };
  }

  // L2 LLM：L1 三档全空 —— 用户零素材，不调 LLM（浪费 + 容易编）
  // 唯一可触达 LLM 的路径：allowLlm=true（默认 false，留给后续迭代开启）
  if (input.allowLlm === true) {
    const llmFn = input.llmFn ?? defaultLlm;
    const digestLines: string[] = [];
    if (input.lastMemoryText) digestLines.push(`最近一条 memory：${input.lastMemoryText}`);
    if (input.stageGoal) digestLines.push(`当前阶段目标：${input.stageGoal}`);
    if (input.lastTouchedPrompt) digestLines.push(`最近一条想试：${input.lastTouchedPrompt}`);
    if (digestLines.length === 0) {
      // 没素材，LLM 也会瞎编——直接 L3
      return { text: input.fallback, source: 'fallback', hitRedLine: false };
    }
    const user = digestLines.join('\n');
    const raw = await llmFn({
      system: tpl.llmSystem,
      user,
      maxTokens: 180,
      temperature: 0.7,
    });
    if (raw && raw.trim()) {
      const cleaned = cleanLlmOutput(raw);
      if (cleaned && !hitRedLine(cleaned)) {
        return { text: cleaned, source: 'llm', hitRedLine: false };
      }
      // 撞红线：静默降级 L3（不暴露 LLM 输出）
      if (cleaned) {
        return {
          text: input.fallback,
          source: 'fallback',
          hitRedLine: true,
          redLineMatches: findRedLineMatches(cleaned),
        };
      }
    }
  }

  // L3 兜底
  return { text: input.fallback, source: 'fallback', hitRedLine: false };
}