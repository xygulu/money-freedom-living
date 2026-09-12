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

/** 确定性抽取：同 seed 同一条 */
export function pickReceiptFallback(locale: string, seed: string): string {
  const lines = RECEIPT_FALLBACKS[locale] ?? RECEIPT_FALLBACKS.en;
  const s = String(seed);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) | 0;
  return lines[(h >>> 0) % lines.length];
}
