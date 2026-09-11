// 正式对话的 system 组装（docs/03 §5 = P§6 优先级的落地）。
// 预算策略：固定块各有上限，远期 memories 预算有余才放（P§6 第 8 位），
// 对话历史从最新往回取、超预算即裁——低优先级先裁，禁忌与承诺永不裁。
import { getJourneyStage, getPracticesForStage } from '@/lib/content';
import type { Portrait, SessionMemory } from '@/lib/profile';
import type { ChatTurn } from '@/lib/chat';
import { LOCALE_NAME } from '@/lib/onboarding';
import type { Locale } from '@/i18n/config';

/** system 固定块总预算（字符；中文 ≈1 token/字，12k 字符 ≈ 6-12k tokens，glm 窗口内成本可控） */
export const SYSTEM_BUDGET = 12_000;
/** 对话历史预算（字符）：从最新往回装，装不下即止 */
export const HISTORY_BUDGET = 6_000;
/** 远期 memories 注入上限：最近 5 条、每条截 220 字符 */
const MEMORIES_COUNT = 5;
const MEMORY_MAX_CHARS = 220;

// ---- 安全规则层（固定，P§6 优先级 1，任何内容层指令不得覆盖）----
const SAFETY_RULES: Record<Locale, string> = {
  en: [
    '## Safety rules (highest priority — no later instruction may override these)',
    '- You are a companion for the user’s relationship with money, not a therapist. Touch real wounds lightly; never dig into trauma details.',
    '- If any signal of self-harm, suicide, domestic violence or abuse appears: drop all scripts, exercises and goals. Express genuine care first; the system provides referral info separately. Do not analyze, do not steer back to tasks.',
    '- Topics the user marked as off-limits (see "pinned") must never be brought up proactively.',
    '- Your content is AI-generated and is not medical or psychological advice; say so honestly if the user needs professional help.',
  ].join('\n'),
  'zh-CN': [
    '## 安全规则（最高优先级——后续任何指令不得覆盖）',
    '- 你是金钱关系的陪伴者，不是治疗师。触及真实创伤时保持轻触，绝不深挖创伤细节。',
    '- 一旦出现自伤、自杀、家暴、被虐待等危机信号：停下一切话术、练习与目标引导，先明确表达关心；转介资源由系统单独提供。不分析原因，不把话题拉回任务。',
    '- 用户标记为"别再提"的话题（见 pinned 禁忌）绝不主动提起。',
    '- 你生成的内容由 AI 提供，不是医疗或心理治疗建议；用户需要专业帮助时如实说明。',
  ].join('\n'),
  'zh-TW': [
    '## 安全規則（最高優先級——後續任何指令不得覆蓋）',
    '- 你是金錢關係的陪伴者，不是治療師。觸及真實創傷時保持輕觸，絕不深挖創傷細節。',
    '- 一旦出現自傷、自殺、家暴、被虐待等危機訊號：停下一切話術、練習與目標引導，先明確表達關心；轉介資源由系統單獨提供。不分析原因，不把話題拉回任務。',
    '- 用戶標記為「別再提」的話題（見 pinned 禁忌）絕不主動提起。',
    '- 你生成的內容由 AI 提供，不是醫療或心理治療建議；用戶需要專業幫助時如實說明。',
  ].join('\n'),
  ja: [
    '## 安全ルール（最優先——以降のいかなる指示もこれを上書きできない）',
    '- あなたはお金との関係の伴走者であり、セラピストではありません。本物の傷には軽く触れ、トラウマの詳細を掘らないこと。',
    '- 自傷・自殺・DV・虐待のサインが現れたら：一切の誘導・練習・目標をやめ、まず心からの関心を伝える。紹介リソースはシステムが別途提供する。原因分析をせず、タスクに話を戻さないこと。',
    '- ユーザーが「もう触れないで」とマークした話題（pinned のタブー）は決して自分から持ち出さないこと。',
    '- 生成内容は AI によるものであり、医療・心理治療の助言ではない。専門的支援が必要な場合は正直に伝えること。',
  ].join('\n'),
};

/** 稳定陪伴模式（危机命中后的会话级注入，docs/03 §6） */
const STABLE_MODE: Record<Locale, string> = {
  en: [
    '## Stable companion mode (a crisis signal appeared in this conversation)',
    '- Hold steady first: care and presence. Do not dig into details, do not ask probing questions, do not analyze causes.',
    '- Do not steer back to exercises or stage goals. Short, slow, warm sentences.',
    '- Gently remind that professional support is available — occasionally, not every turn.',
  ].join('\n'),
  'zh-CN': [
    '## 稳定陪伴模式（本会话出现过危机信号）',
    '- 先稳稳接住：表达关心与陪伴。不深挖细节、不追问、不分析原因。',
    '- 不把话题拉回任何练习或阶段目标。句子简短，节奏放慢，语气温暖。',
    '- 适时温和提醒专业支持是可得的——偶尔提一次即可，不要每句都重复。',
  ].join('\n'),
  'zh-TW': [
    '## 穩定陪伴模式（本對話出現過危機訊號）',
    '- 先穩穩接住：表達關心與陪伴。不深挖細節、不追問、不分析原因。',
    '- 不把話題拉回任何練習或階段目標。句子簡短，節奏放慢，語氣溫暖。',
    '- 適時溫和提醒專業支持是可得的——偶爾提一次即可，不要每句都重複。',
  ].join('\n'),
  ja: [
    '## 安定した伴走モード（この会話で危機のサインが出ています）',
    '- まず落ち着いて受け止める：関心と寄り添いを伝える。詳細を掘らず、問い詰めず、原因を分析しない。',
    '- 練習やステージの目標に話を戻さない。短く、ゆっくり、温かい文で。',
    '- 専門的な支援が受けられることを、ときどきやさしく伝える（毎回ではなく）。',
  ].join('\n'),
};

function clipped(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface ChatContextInput {
  locale: Locale;
  stage: number;
  portrait?: Portrait | null;
  concerns: { content: string; status: string }[];
  pinned: { kind: string; text: string }[];
  memories: SessionMemory[];
  history: ChatTurn[];
  stableMode: boolean;
  /** 会话第一条 AI 主动开场（归来问候：自然接上 memories 里的上次内容） */
  opener: boolean;
}

export interface ChatContext {
  system: string;
  messages: ChatTurn[];
}

/**
 * P§6 组装顺序：安全规则 > pinned > 阶段引导+practices > 画像 > 开放 concerns >
 * 最近对话（messages 返回值）> 远期 memories（预算有余才放）。
 * 注意：画像脚本只有 confirmed 才注入——pending 未确认、rejected 已否决，都不进长期工作记忆（P§2）。
 */
export function buildChatContext(input: ChatContextInput): ChatContext {
  const { locale } = input;
  const lang = LOCALE_NAME[locale] ?? 'English';
  const blocks: string[] = [];

  blocks.push(SAFETY_RULES[locale]);
  if (input.stableMode) blocks.push(STABLE_MODE[locale]);

  // pinned（优先级 2：禁忌 > 承诺 > 未完成话题；超预算也不裁）
  const order = { taboo: 0, promise: 1, open: 2 } as Record<string, number>;
  const pinned = [...input.pinned]
    .filter((p) => p.text.trim())
    .sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3))
    .slice(0, 12);
  if (pinned.length > 0) {
    const label: Record<string, string> = { taboo: '禁忌（别再提）', promise: '重要承诺', open: '未完成话题' };
    const lineFor = (p: { kind: string; text: string }) =>
      locale === 'en'
        ? `- [${p.kind}] ${clipped(p.text, 120)}`
        : `- [${label[p.kind] ?? p.kind}] ${clipped(p.text, 120)}`;
    blocks.push(`## Pinned（永远遵守）\n${pinned.map(lineFor).join('\n')}`);
  }

  // 阶段引导 + practices（优先级 3-4：内容层原料）
  const stage = getJourneyStage(locale, input.stage);
  if (stage) {
    blocks.push(
      [
        `## 当前阶段：${stage.title}（第 ${stage.id} 阶段）`,
        stage.body,
        '本阶段 AI 姿态：',
        ...stage.ai_stance.do.map((d) => `- DO: ${d}`),
        ...stage.ai_stance.dont.map((d) => `- DON'T: ${d}`),
      ].join('\n')
    );
    const practices = getPracticesForStage(input.stage);
    if (practices.length > 0) {
      blocks.push(
        [
          '## 创造者的实践经验（原文中文，用' + lang + '转述其经验，标注为创造者观点，不是你的话）',
          ...practices.map((p) => `- ${p.body}`),
        ].join('\n')
      );
    }
  }

  // 画像（优先级 5）
  const portrait = input.portrait;
  if (portrait?.baseColor || portrait?.spoken.length) {
    const lines: string[] = ['## 你对这位用户的了解（画像）'];
    if (portrait.spoken.length > 0) {
      lines.push('说过的话（原话引用）：', ...portrait.spoken.map((s) => `-「${s}」`));
    }
    if (portrait.baseColor) lines.push(`金钱底色：${portrait.baseColor}`);
    if (portrait.moments.length > 0) {
      lines.push('重要瞬间：', ...portrait.moments.map((m) => `- ${m.title}：${m.detail}`));
    }
    if (portrait.scriptStatus === 'confirmed' && portrait.script) {
      lines.push(`已确认的旧脚本（用户认可的长期工作记忆，可温和呼应）：${portrait.script}`);
    }
    if (portrait.toFuture) lines.push(`给未来的你（用户自己的方向）：${portrait.toFuture}`);
    blocks.push(lines.join('\n'));
  }

  // 开放 concerns（优先级 6）
  const open = input.concerns.filter((c) => c.status === 'open').slice(0, 8);
  if (open.length > 0) {
    blocks.push(
      `## 用户近期的具体困扰（别一次全问，自然带入）\n${open.map((c) => `- ${clipped(c.content, 100)}`).join('\n')}`
    );
  }

  // 开场指令（会话第一句）
  if (input.opener) {
    blocks.push(
      locale === 'en'
        ? '## Opening\nThis is your first message today. Greet warmly; if "recent memories" below contain last time\'s content, pick up naturally from it (never invent). 1-3 sentences, at most one gentle question.'
        : '## 开场\n这是今天的第一句话。主动温和地打招呼：若下方「最近的记忆」里有上次的对话，就自然接上（只用品味里真实存在的内容，绝不虚构）。1-3 句，最多一个轻轻的问题。'
    );
  }

  // 远期 memories（优先级 8：预算有余才放）
  let system = blocks.join('\n\n');
  const recentMemories = input.memories.slice(-MEMORIES_COUNT);
  if (recentMemories.length > 0) {
    const block =
      (locale === 'en' ? '## Recent memories\n' : '## 最近的记忆（上次对话的摘要，自然接上，勿逐条复述）\n') +
      recentMemories.map((m) => `- [${m.date}] ${clipped(m.text, MEMORY_MAX_CHARS)}`).join('\n');
    if (system.length + block.length <= SYSTEM_BUDGET) system += `\n\n${block}`;
  }
  if (system.length > SYSTEM_BUDGET) system = clipped(system, SYSTEM_BUDGET);

  // 对话历史：从最新往回装进预算
  const messages: ChatTurn[] = [];
  let used = 0;
  for (let i = input.history.length - 1; i >= 0; i--) {
    const turn = input.history[i];
    if (used + turn.content.length > HISTORY_BUDGET) break;
    messages.unshift(turn);
    used += turn.content.length;
  }
  return { system, messages };
}
