import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en.json';
import zhCN from '@/i18n/messages/zh-CN.json';
import zhTW from '@/i18n/messages/zh-TW.json';
import ja from '@/i18n/messages/ja.json';

const LOCALES = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja } as const;

const read = (dict: unknown, path: string): string => {
  const v = path.split('.').reduce<unknown>((node, k) => (node as Record<string, unknown> | undefined)?.[k], dict);
  if (typeof v !== 'string') throw new Error(`缺文案或不是字符串：${path}`);
  return v;
};

/** 陪伴者自己在说话的文案——人称只能是「我」。它就是和用户交互的那个产品本身。 */
const COMPANION_VOICE = [
  'common.aiNotice',
  'journey.chatHint',
  'journey.letterHint',
  'journey.welcomeBack',
  'journey.stageLampWaiting',
  'evolve.busy',
  'assess.invite',
  'assess.hint',
  'assess.busy',
  'assess.reviewIntro',
  'assess.stageLine',
  'assess.summaryLabel',
  'assess.evidenceLead',
  'assess.latestLabel',
  'journal.sub',
  'journal.replyPending',
  'journal.replyLabel',
  'letters.sub',
  'letters.replyLabel',
  'onboarding.talk.hint',
  'chat.subtitle',
  'chat.quotaExhausted',
  'chat.replyInProgress',
  'chat.historyEmpty',
  'changes.wordsLabel',
  'changes.failed',
];

/** 用户口吻的按钮：「我」在这里是用户自己，陪伴者不能来抢这个字——所以不带主语 */
const USER_VOICE_BUTTONS = ['journal.replyBtn', 'changes.generate'];

/** 这些「它」指的是旧脚本/早期场景/画像等物件，不是陪伴者——必须留着，否则句子没了主语 */
const OBJECT_IT = [
  'journey.stageLampStoryHint',
  'journey.stageLampScriptHint',
  'journey.stageLampClaimHint',
  'journey.stageLampSevenHint',
  'portrait.historicalBanner',
  'me.portraitDone',
];

describe('人称口径：陪伴者是「我」，不是「它」', () => {
  it.each(['zh-CN', 'zh-TW'] as const)('%s：陪伴者自述的文案一处「它」都不许有', (loc) => {
    for (const path of COMPANION_VOICE) {
      const text = read(LOCALES[loc], path);
      expect(text, `${loc} ${path}`).not.toContain('它');
      expect(text, `${loc} ${path}`).toContain('我');
    }
  });

  it.each(['zh-CN', 'zh-TW'] as const)('%s：用户口吻的按钮不带陪伴者主语，「我」留给用户', (loc) => {
    for (const path of USER_VOICE_BUTTONS) {
      expect(read(LOCALES[loc], path), `${loc} ${path}`).not.toContain('它');
    }
    // 「让它替我写」这类写法会变成「我替我写」，必须已被改掉
    expect(read(LOCALES[loc], 'changes.generate')).not.toContain('让我替我');
  });

  it.each(['zh-CN', 'zh-TW'] as const)('%s：指物件的「它」保持不动——旧脚本那个「它」正是用户认领的对象', (loc) => {
    for (const path of OBJECT_IT) {
      expect(read(LOCALES[loc], path), `${loc} ${path}`).toContain('它');
    }
  });

  it('en：陪伴者不再用 it 自称（逐条钉住最容易被改回去的抬头）', () => {
    expect(read(en, 'assess.summaryLabel')).toBe('The you I see');
    expect(read(en, 'assess.latestLabel')).toBe('What I see in you');
    expect(read(en, 'assess.evidenceLead')).toBe('I remember: ');
    expect(read(en, 'assess.stageLine')).toBe('Where I see you: Stage {n} · {title}');
    expect(read(en, 'changes.wordsLabel')).toBe('What I want to say to you');
    expect(read(en, 'journal.replyLabel')).toBe('My response');
    expect(read(en, 'letters.replyLabel')).toBe('My reply');
    for (const path of COMPANION_VOICE) {
      // 陪伴者当主语的 it（It remembers / it will / it sees）与 Its 一律不许再出现；
      // 指物件的 it 仍是合法英文（Write it down / whether it rings true），所以按主语搭配查
      expect(read(en, path), path).not.toMatch(
        /\b[Ii]t'?s?\s+(remember|remembers|see|sees|will|is|was|does|did|didn't|doesn't|couldn't|can|keeps|keep|only|reading|rereading)\b/
      );
      expect(read(en, path), path).not.toMatch(/\b[Ii]ts\b/);
    }
  });

  it('ja：变化清单抬头是「わたし」，不是「それ」', () => {
    expect(read(ja, 'changes.wordsLabel')).toBe('あなたへ、わたしが言いたいこと');
  });

  it('四语言都有这些键——加语言时不会漏掉人称口径', () => {
    for (const loc of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
      for (const path of [...COMPANION_VOICE, ...USER_VOICE_BUTTONS]) {
        expect(() => read(LOCALES[loc], path), `${loc} ${path}`).not.toThrow();
      }
    }
  });
});
