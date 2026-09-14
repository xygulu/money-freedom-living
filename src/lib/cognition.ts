// 认知层（docs/10 P0-1）：L5 停顿 / L4 迁移 / M 恢复时间 三个指标的采集与判定。
//
// 一条贯穿的约束（docs/10 §0）：**不能为了采集给用户加第三个日常任务。**
// 所以这里没有任何新的日常动作——三个指标全部从「合」那一格里已经填的三行里长出来：
//   ① 我做了吗   → 行为层（node_verdict 的 behavior_ok）
//   ② 我想到什么 → 即时回应的原料（不做指标）
//   ③ 脑子里第一句话 → L5（填了就是一次停顿）、L4/M（这句话是新说法还是旧句式）
//
// 三条红线在这个文件里的样子：
// - **L5 可跳过**：③ 留空、点「想不起来」都照常提交，只是不记停顿。压垮自发继续率
//   的从来不是"少一个指标"，是"又多一个必答题"。
// - **L4 必须用户亲手确认**：AI 只负责"看见一个新说法"并提议，记不记是用户说了算，
//   且记完还能真删（`deleteThreadEvidence`）。让用户自己判断"这算不算迁移"＝把测量
//   负担推给用户；让 AI 直接记＝背着人贴标签。两边都不行，只有"提议 + 确认"行。
// - **M 绝不进界面**：regress 是给读取端算天数用的，写进库、不展示、不通知、不提醒。
//   「你掉回去了」这句话产品里一个字都不会出现。
import { lampsFor } from '@/lib/stage';
import { TOPICS, type TopicId } from '@/lib/content';
import type { EvidenceKind, GrowthProfile, ThreadEvidence } from '@/lib/profile';
import { llmCompleteJson } from '@/lib/llm';
import type { Locale } from '@/i18n/config';

/** ① 我做了吗：三态。**必选**——这一格唯一必须有答案的一行（它是行为层的全部） */
export type DidToday = 'done' | 'partial' | 'missed';
export const DID_VALUES: DidToday[] = ['done', 'partial', 'missed'];
export function isDidToday(v: unknown): v is DidToday {
  return typeof v === 'string' && (DID_VALUES as string[]).includes(v);
}

/** ③ 那一行最多存多少字：一行就是一行，长了就不是"第一句话"了 */
export const FIRST_LINE_MAX = 300;
/** ② 同上 */
export const THOUGHT_MAX = 300;

/**
 * 这一格挂在哪条命题线上。
 *
 * 优先信 AI 的判断（它读了这个人说的话）；AI 不可用或给了不认识的命题时，回落到
 * **当前段第一盏灯的命题**——段是这本书安排今天要碰的那件事，它的灯挂在哪条线上，
 * 今天这一格大概率也在那条线上。再不行（阶段 4 无灯）就跟着"最近碰过的那条线"走，
 * 最后才是 allowing（这本书的收尾命题）。
 * 宁可挂错一条线，也不要因为"不知道挂哪"就把这句话丢了——原话丢了就再也回不来。
 */
export function topicForToday(
  profile: Pick<GrowthProfile, 'stage' | 'threads'>,
  bookId: string,
  hinted?: unknown
): TopicId {
  if (typeof hinted === 'string' && (TOPICS as readonly string[]).includes(hinted)) return hinted as TopicId;
  const lamp = lampsFor(bookId, profile.stage)[0]?.topic;
  if (lamp) return lamp;
  const recent = Object.entries(profile.threads ?? {})
    .filter(([, t]) => t?.lastSeenAt)
    .sort((a, b) => Date.parse(a[1]!.lastSeenAt) - Date.parse(b[1]!.lastSeenAt))
    .pop();
  if (recent && (TOPICS as readonly string[]).includes(recent[0])) return recent[0] as TopicId;
  return 'allowing';
}

/** ③ 这句话算不算"停顿"：填了、且不是点的「想不起来」，就算 */
export function isPause(firstLine: string, skipped: boolean): boolean {
  return !skipped && firstLine.trim().length > 0;
}

/** 历史上他在这条线上说过的那些话（给 AI 做"新/旧"对照用，只取带 kind 的） */
export function priorLines(profile: Pick<GrowthProfile, 'threads'>, limit = 8): ThreadEvidence[] {
  return Object.values(profile.threads ?? {})
    .flatMap((t) => t?.evidence ?? [])
    .filter((e) => e.kind && (e.quote ?? '').trim())
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-limit);
}

export interface LineVerdict {
  /** new = 说法变了（L4 迁移的候选）｜old = 掉回旧句式（M 的起点）｜unclear = 说不好 */
  verdict: 'new' | 'old' | 'unclear';
  topic?: TopicId;
}

const CLASSIFY_SYSTEM = [
  '你在读一个人每天写下的「脑子里冒出来的第一句话」，只做一件事：判断今天这句话和他以前说过的话相比，是**新的说法**、**旧的句式**，还是**说不好**。',
  '',
  '判据（只看这三条，不要加戏）：',
  '- new：他给出了一个**新的做法或新的解释**——同一件事，他这次的说法和以前不一样了。',
  '- old：他**回到了以前那句**——同一个自我否定/同一套旧解释又原样出现。',
  '- unclear：看不出来，或没有可比的历史。**拿不准一律给 unclear**，宁可漏判不可错判。',
  '',
  '再判一次这句话落在哪条命题线上（只能从给定清单里选，选不出就不给 topic）。',
  '',
  '绝对不要：评价这句话的好坏、给建议、给结论、揣测他的心理问题。你的输出只有机器会读，用户永远看不到。',
  '只输出 JSON：{"verdict":"new|old|unclear","topic":"<命题 id 或省略>"}',
].join('\n');

/**
 * 让 AI 看一眼今天这句话是"新说法"还是"掉回旧句式"。
 *
 * 为什么不做本地文本相似度：旧句式的复发是**语义**上的（「我不配」和「凭什么是我」
 * 是同一句），字面比对只会把改了两个字的同一句判成新的——那样 L4 会虚高、M 会永远
 * 不触发，两个指标一起废掉。
 * 拿不准就返回 unclear：这个函数的产物一边通向"要不要提议记一笔迁移"（用户还要再确认
 * 一次），一边通向 regress（不进界面）——两边都宁可少记。
 */
export async function classifyFirstLine(params: {
  locale: Locale;
  firstLine: string;
  prior: ThreadEvidence[];
}): Promise<LineVerdict> {
  const line = params.firstLine.trim();
  if (!line) return { verdict: 'unclear' };
  const history = params.prior.length
    ? params.prior.map((e) => `- [${e.at.slice(0, 10)}${e.kind ? ` · ${e.kind}` : ''}]「${e.quote}」`).join('\n')
    : '（没有历史记录）';
  try {
    const out = await llmCompleteJson<{ verdict?: string; topic?: string }>({
      system: CLASSIFY_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            `命题清单：${TOPICS.join(' / ')}`,
            '',
            '他以前说过的话（按时间从早到晚）：',
            history,
            '',
            `今天这一句：「${line}」`,
          ].join('\n'),
        },
      ],
      maxTokens: 200,
    });
    const verdict = out?.verdict === 'new' || out?.verdict === 'old' ? out.verdict : 'unclear';
    const topic = typeof out?.topic === 'string' && (TOPICS as readonly string[]).includes(out.topic)
      ? (out.topic as TopicId)
      : undefined;
    return { verdict, topic };
  } catch {
    // 判不了就当没判——认知层的采集不许拖累用户交完这一格
    return { verdict: 'unclear' };
  }
}

/**
 * M 恢复时间：从**掉回旧模式**到**回到新说法**之间隔了几天。
 * 天数由读取端算、不落库（落了就得维护两处真值）；没恢复的返回 null（还在里面）。
 * 取每一次 regress 之后**最近的一次 migrate**——一次掉回配一次回来，不跨配。
 */
export function recoveryDays(profile: Pick<GrowthProfile, 'threads'>): number[] {
  const marks = Object.values(profile.threads ?? {})
    .flatMap((t) => t?.evidence ?? [])
    .filter((e) => e.kind === 'regress' || e.kind === 'migrate')
    .map((e) => ({ kind: e.kind as EvidenceKind, at: Date.parse(e.at) }))
    .filter((e) => !Number.isNaN(e.at))
    .sort((a, b) => a.at - b.at);
  const out: number[] = [];
  let fell: number | null = null;
  for (const m of marks) {
    if (m.kind === 'regress') {
      if (fell === null) fell = m.at; // 连着掉几次只算第一次——中间没回来过
    } else if (fell !== null) {
      out.push(Math.max(0, Math.round((m.at - fell) / 86_400_000)));
      fell = null;
    }
  }
  return out;
}

// ───────── 6 个节点的三态判断（docs/10 P0-2）─────────

/** 六个节点各问一个不同的问题，且每个都是决策点（docs/10 §2.1） */
export const VERDICT_NODES = ['D7', 'D14', 'D21', 'D30', 'D66', 'D90'] as const;
export type VerdictNode = (typeof VERDICT_NODES)[number];
export function isVerdictNode(v: unknown): v is VerdictNode {
  return typeof v === 'string' && (VERDICT_NODES as readonly string[]).includes(v);
}

export interface NodeVerdict {
  verdict: 'yes' | 'no' | 'pending';
  behaviorOk: boolean;
  cognitionOk: boolean;
}

/**
 * 三态：**行为层与认知层成对**才算数（`20-1` 判定表）。
 * - 两层都有 → `yes`
 * - 两层都没有 → `no`
 * - 只有一层 → `pending`：其中"行为达标、认知不达标"就是判定表里说的**机制空转**。
 *   为什么空转不直接判 `no`：`no` 会触发提前收官，而收官是对**整轮验证**下结论，
 *   不能由某一个人某一天的一句话来定。空转要靠下一个节点的复现来坐实。
 *
 * ⚠️ 这里**只算三态、不算达标线**。`20-1` 里 ≥70%/≥60%/≥40%/1.5× 那几个门槛目前
 * 全无出处（docs/10 已登记），第一轮的做法是**只记实际值**，跑完 D14 用实际分布回填。
 */
export function nodeVerdict(params: { did: DidToday; pause: boolean }): NodeVerdict {
  const behaviorOk = params.did === 'done';
  const cognitionOk = params.pause;
  const verdict = behaviorOk && cognitionOk ? 'yes' : !behaviorOk && !cognitionOk ? 'no' : 'pending';
  return { verdict, behaviorOk, cognitionOk };
}
