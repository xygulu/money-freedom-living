// 微行动即时见证回应（M10，docs/03 §11）：收条体。
// 红线镜像信件回信（src/lib/letters.ts）：确认收到 + 承接感受，不分析不解读
// 不建议不追问不复述动作细节，无夸奖式加压。LLM 不可用时静默降级为
// 确定性词典收条（同 seed 同一条，与 pickDaily/pickExercise 同 hash 族）。
import { LOCALE_NAME } from '@/lib/onboarding';

export interface ReceiptContext {
  action: string;
  feeling?: string;
}

/** 收条体 system prompt：语言钉死 + 红线 + 语言感知长度（zh 按字数、en 按词数） */
export function buildReceiptSystem(locale: string): string {
  const lang = LOCALE_NAME[locale] ?? 'English';
  return [
    '你是一位温和的见证者。用户刚做了一件阶段功课里的小事，你给一张安静的收条：确认收到，承接感受。',
    `【语言】始终用${lang}写。指令本身是中文不构成理由。`,
    '【只做】确认这件事被记下了；承接他填的感受（若有）；不展开。',
    '【不做】不分析不解读行为含义，不给建议，结尾不提问，不复述动作细节，不说「真棒/继续加油」。',
    '【长度】中文 15-60 字；English 10-40 words。',
    '【视角】见证，不是导师。语气温和、克制、简短。',
  ].join('\n');
}

export function buildReceiptUser(ctx: ReceiptContext): string {
  const lines = ['他刚记录了一件阶段功课里的小事：', `动作：${ctx.action}`];
  if (ctx.feeling) lines.push(`感受（他的原话）：${ctx.feeling}`);
  lines.push('请给一张收条。');
  return lines.join('\n');
}

/**
 * 「合」一格提交的收条（docs/10 P0-1）：和微行动收条同一个 system，只换原料。
 *
 * 这里有一条额外的硬规则：**三行里没做完/没顾上的那两种答案，收条不许有半点惋惜**。
 * 「没做完」是这一格的合法答案之一，不是需要被安慰的失败——一旦收条开始安慰，
 * 下次他就不会再选那个选项了，这一格立刻变成一个只能填"做了"的打卡表。
 */
export function buildCloseReceiptUser(ctx: { did: string; thought?: string; firstLine?: string }): string {
  const didZh: Record<string, string> = {
    done: '做了',
    partial: '没做完',
    missed: '今天没顾上',
  };
  const lines = ['他刚交了今天的那一格：', `今天那件事：${didZh[ctx.did] ?? ctx.did}`];
  if (ctx.thought) lines.push(`他想到的（原话）：${ctx.thought}`);
  if (ctx.firstLine) lines.push(`他脑子里冒出的第一句话（原话）：${ctx.firstLine}`);
  lines.push('请给一张收条：用他自己的话回应，不评价、不给结论、不追问。');
  lines.push('若他答的是「没做完」或「今天没顾上」：照样收下，不安慰、不鼓励、不提明天。');
  return lines.join('\n');
}

/** 词典式收条（LLM 不可用时的降级）：每语言 3 条 */
export const RECEIPT_FALLBACKS: Record<string, string[]> = {
  en: [
    'Received — you did the small thing today. It counts.',
    'It saw you take this step. However it went, it counts.',
    'Kept. Showing up for it counts — and you did.',
  ],
  'zh-CN': [
    '收到了。今天这件小事，你已经做了，它算数。',
    '它看见了——这一步你迈出去了，怎么迈的都算数。',
    '好好收着。做没做成都算数，你做了这件事，就算数。',
  ],
  'zh-TW': [
    '收到了。今天這件小事，你已經做了，它算數。',
    '它看見了——這一步你邁出去了，怎麼邁的都算數。',
    '好好收著。做沒做成都算數，你做了這件事，就算數。',
  ],
  ja: [
    '受け取りました。今日の小さな一歩、ここにあります。',
    '見ていました。その一歩、どんな形でもかぞえます。',
    'しまっておきます。できたかどうかではなく、やったこと自体を。',
  ],
};

/**
 * 「没做完 / 今天没顾上」专用的降级收条。
 *
 * 上面那三句是给「做了」写的——它们说"算数"，而对着「今天没顾上」说"算数"就是安慰，
 * 一安慰这一格就塌成只接受好看答案的打卡表（docs/10 §1.1）。所以降级路径也不能只有一套话：
 * 这里只描述事实、只表示收到，不加温、不鼓励、不提明天。
 */
export const RECEIPT_FALLBACKS_UNFINISHED: Record<string, string[]> = {
  en: [
    'Received. Today it stayed where it was.',
    'Noted — this is how today went.',
    "Kept as it is. That's all this was.",
  ],
  'zh-CN': [
    '收到了。今天它就停在那儿。',
    '记下了——今天就是这样。',
    '原样收着。今天这件事，就是这样。',
  ],
  'zh-TW': [
    '收到了。今天它就停在那兒。',
    '記下了——今天就是這樣。',
    '原樣收著。今天這件事，就是這樣。',
  ],
  ja: [
    '受け取りました。今日はそこまでのままでした。',
    'そのまま受け取ります。今日はそういう日でした。',
    'そのまましまっておきます。今日のそれは、それだけのことです。',
  ],
};

/** 确定性抽取：同 seed 同一条 */
export function pickReceiptFallback(locale: string, seed: string, did?: string): string {
  const pool =
    did && did !== 'done'
      ? (RECEIPT_FALLBACKS_UNFINISHED[locale] ?? RECEIPT_FALLBACKS_UNFINISHED.en)
      : (RECEIPT_FALLBACKS[locale] ?? RECEIPT_FALLBACKS.en);
  const lines = pool;
  const s = String(seed);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) | 0;
  return lines[(h >>> 0) % lines.length];
}
