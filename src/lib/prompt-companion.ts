// 陪伴者弹层的轻量 system 组装（2026-09-18，companion 弹层 chat 化）。
//
// 与 buildChatContext（prompt.ts，/chat 正式对话）刻意分开：
// 弹层是"顺便说一句"的轻场景——不注入每日两问协议、失败接法、阶段实践、
// 画像/pinned/命题线；只带安全红线 + 语言钉死 + 少量记忆，让陪伴者能认出
// 用户、接得住话，但不多话。上下文越轻，弹层回复越快、越不像"任务"。
//
// 共享：SAFETY_RULES / LANGUAGE_RULES 直接 import prompt.ts（同一份红线，
// 任何调用点不得自造）。
// quote/nudge 的引用不在这里注入——前端把引用作为首条 user 消息正常发送
// （走 checkSafety + appendMessage，自然落对话历史，用户回看得见）。
import { SAFETY_RULES, LANGUAGE_RULES } from '@/lib/prompt';
import { nowBlock } from '@/lib/time';
import { LOCALE_NAME } from '@/lib/onboarding';
import type { ChatTurn } from '@/lib/chat';
import type { SessionMemory } from '@/lib/profile';
import type { Locale } from '@/i18n/config';

/** memories 注入上限：最近 3 条、每条截 140 字符（比 /chat 的 5×220 更轻） */
const MEMORIES_COUNT = 3;
const MEMORY_MAX_CHARS = 140;
/** concerns 注入上限：open 最多 2 条、每条截 100 字符 */
const CONCERNS_COUNT = 2;
const CONCERN_MAX_CHARS = 100;
/** 弹层内历史预算：从最新往回裁到 2000 字符（弹层回复短，历史长了反而教它长篇） */
export const COMPANION_HISTORY_BUDGET = 2_000;

export interface CompanionContextInput {
  locale: Locale;
  stage: number;
  memories: SessionMemory[];
  concerns: { content: string; status: string }[];
  history: ChatTurn[];
  tz: string;
  /** 陪伴者气泡刚说过的话（nudge 文案）：他点开弹层，多半接着这个说 */
  openingLine?: string | null;
}

export interface CompanionContext {
  system: string;
  messages: ChatTurn[];
}

const POSTURE: Record<Locale, string> = {
  en: [
    '## This conversation',
    '- This is the corner companion — a brief, casual chat opened from a small bubble, not the day’s main session.',
    '- Keep replies short (1-3 sentences). Warm, concrete, present. No exercises, no homework, no stage goals, no task lists.',
    '- Do not summarize the journey or evaluate progress. Just talk with him like someone who remembers him.',
    '- At most one question per reply, and only if it truly helps him say more. Silence and reflection are fine too.',
  ].join('\n'),
  'zh-CN': [
    '## 这场对话',
    '- 你是右下角的那位陪伴者——这是一段从气泡里随手打开的轻对话，不是今天的正式对话。',
    '- 回复短（1-3 句）。温暖、具体、在场。不给练习、不留作业、不提阶段目标、不列任务清单。',
    '- 不总结旅程、不评估进度。就像一个记得他的人，跟他说说话。',
    '- 每条回复最多一个问号，且只在真能帮他说下去时才问。不问、只接住，也完全可以。',
  ].join('\n'),
  'zh-TW': [
    '## 這場對話',
    '- 你是右下角的那位陪伴者——這是一段從氣泡裡隨手打開的輕對話，不是今天的正式對話。',
    '- 回覆短（1-3 句）。溫暖、具體、在場。不給練習、不留作業、不提階段目標、不列任務清單。',
    '- 不總結旅程、不評估進度。就像一個記得他的人，跟他說說話。',
    '- 每條回覆最多一個問號，且只在真能幫他說下去時才問。不問、只接住，也完全可以。',
  ].join('\n'),
  ja: [
    '## この会話について',
    '- あなたは画面の隅の伴走者です。これは小さなふきだしから開いた気軽な会話であって、今日のメインセッションではありません。',
    '- 返信は短く（1〜3文）。温かく、具体的に、そばにいるように。練習を課さず、宿題を出さず、ステージの目標にも戻らない。',
    '- 旅のまとめや進捗の評価をしない。ただ、彼のことを覚えている誰かとして、話をする。',
    '- 返信につける問いかけは多くて一つ。本当に彼が話を続けられるときだけ。問わずに受け止めるだけでもいい。',
  ].join('\n'),
};

const MATERIAL_HEADER: Record<Locale, string> = {
  en: '## What you remember about him (paraphrase, never recite)',
  'zh-CN': '## 你记得的他（转述，不背诵）',
  'zh-TW': '## 你記得的他（轉述，不背誦）',
  ja: '## 彼について覚えていること（そのまま唱えず、言い換える）',
};

const STAGE_LABEL: Record<Locale, string> = {
  en: 'Current stage',
  'zh-CN': '当前阶段',
  'zh-TW': '目前階段',
  ja: '現在のステージ',
};

const CONCERN_LABEL: Record<Locale, string> = {
  en: 'on his mind',
  'zh-CN': '他放着的心事',
  'zh-TW': '掛心上的',
  ja: '気がかり',
};

/** history 从最新往回裁预算：保留最近的，丢弃最老的（与 prompt.ts HISTORY_BUDGET 同策略） */
export function clampHistory(history: ChatTurn[], budget = COMPANION_HISTORY_BUDGET): ChatTurn[] {
  const kept: ChatTurn[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (used + turn.content.length > budget && kept.length > 0) break;
    kept.unshift(turn);
    used += turn.content.length;
  }
  return kept;
}

export function buildCompanionContext(input: CompanionContextInput): CompanionContext {
  const { locale, tz } = input;
  const lang = LOCALE_NAME[locale] ?? 'English';
  const lines: string[] = [];

  lines.push(`你是一位温和的陪伴者，正在弹层里和用户轻声说话。请始终用${lang}回复。`);
  lines.push('', nowBlock(locale, tz));
  lines.push('', SAFETY_RULES[locale]);
  lines.push('', LANGUAGE_RULES[locale]);
  lines.push('', POSTURE[locale]);

  // 少量记忆：让陪伴者认得出他，但不背着"档案"说话
  const memories = input.memories.slice(-MEMORIES_COUNT).map((m) => ({
    date: m.date,
    text: m.text.slice(0, MEMORY_MAX_CHARS),
  }));
  const concerns = input.concerns
    .filter((c) => c.status === 'open')
    .slice(-CONCERNS_COUNT)
    .map((c) => c.content.slice(0, CONCERN_MAX_CHARS));

  if (memories.length > 0 || concerns.length > 0) {
    lines.push('', MATERIAL_HEADER[locale]);
    lines.push(`- ${STAGE_LABEL[locale]}: ${input.stage}`);
    for (const m of memories) lines.push(`- [${m.date}] ${m.text}`);
    for (const c of concerns) lines.push(`- (${CONCERN_LABEL[locale]}) ${c}`);
  }

  // 气泡刚说过的话：他看到这句话才点开的，接话从这里开始
  const openingLine = input.openingLine?.trim();
  if (openingLine) {
    lines.push(
      '',
      locale === 'en'
        ? `## What your bubble just said to him\n"${openingLine}"\nHe opened this chat after reading it — if he speaks, he is most likely continuing this.`
        : locale === 'ja'
          ? `## ふきだしであなたがさっき彼に言ったこと\n「${openingLine}」\n彼はそれを読んでこのチャットを開きました。彼が話すなら、おそらくこの続きです。`
          : locale === 'zh-TW'
            ? `## 你的氣泡剛跟他說的話\n「${openingLine}」\n他讀了這句才點開這個對話——他若開口，多半是接著這個說。`
            : `## 你的气泡刚跟他说的话\n「${openingLine}」\n他读了这句才点开这个对话——他若开口，多半是接着这个说。`
    );
  }

  return { system: lines.join('\n'), messages: clampHistory(input.history) };
}
