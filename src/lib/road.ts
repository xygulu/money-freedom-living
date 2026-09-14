// 「你走过的路」（M11-D，docs/05 §3.5）：把命题线整理成可陈列的一条路。
//
// 这是**书在产品里唯一的露出点**——书在这里只当两样东西：
//   ① 出处：这段路是从哪本书走过来的
//   ② 邀请：同一个命题，还有别的书从另一个角度说过
// 书不出现在日常页、不出现在进度/灯/计数里（docs/02 §12 修订、docs/01 §7）。
//
// 陈列规则跟着「世界感不是游戏化」走（docs/05 §8.1）：
//   - 物件上只放他自己的原话，不写「你进步了」，不给结论
//   - 还没走到的命题是**远处的风景**，不是**欠账**——所以它们有自己的名字（ahead），
//     不叫「未完成」，不计数，不排在走过的路前面
// 纯函数，零 IO，便于单测。
import { getBooks, TOPICS, type BookMeta, type TopicId } from '@/lib/content';
import type { GrowthProfile, ThreadDepth, ThreadEvidence } from '@/lib/profile';

/** 一条命题线在路上的样子。quotes 一律是用户原话（ThreadEvidence.quote 的约定）。 */
export interface RoadLine {
  topic: TopicId;
  depth: ThreadDepth;
  firstSeenAt: string;
  lastSeenAt: string;
  /** 这条线上留下过东西的书（按首次出现顺序去重）——「出处」 */
  sources: string[];
  /** 最近的几句他自己的话（新→旧） */
  quotes: ThreadEvidence[];
}

export interface Road {
  /** 走过的线：最近走的排前面 */
  lines: RoadLine[];
  /** 还没走到的命题（远处的风景，不是欠账） */
  ahead: TopicId[];
  /** 他打开过的书（出处清单，按开始时间排） */
  books: { bookId: string; status: string; startedAt: string; stage: number }[];
}

const DEFAULT_QUOTES = 2;

/** 时间倒序比较（缺失/非法时间一律排到最后，不让脏数据顶到前面） */
function byTimeDesc(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
  if (Number.isNaN(ta)) return 1;
  if (Number.isNaN(tb)) return -1;
  return tb - ta;
}

export function buildRoad(
  profile: Pick<GrowthProfile, 'threads' | 'books'>,
  maxQuotes: number = DEFAULT_QUOTES
): Road {
  const lines: RoadLine[] = [];
  const ahead: TopicId[] = [];

  for (const topic of TOPICS) {
    const thread = profile.threads[topic];
    if (!thread) {
      ahead.push(topic);
      continue;
    }
    const evidence = [...thread.evidence].sort((a, b) => byTimeDesc(a.at, b.at));
    const sources: string[] = [];
    // 出处按「首次出现」顺序——先走的书排前面，所以从旧到新扫
    for (const e of [...evidence].reverse()) {
      if (e.bookId && !sources.includes(e.bookId)) sources.push(e.bookId);
    }
    lines.push({
      topic,
      depth: thread.depth,
      firstSeenAt: thread.firstSeenAt,
      lastSeenAt: thread.lastSeenAt,
      sources,
      quotes: evidence.filter((e) => e.quote?.trim()).slice(0, Math.max(0, maxQuotes)),
    });
  }

  lines.sort((a, b) => byTimeDesc(a.lastSeenAt, b.lastSeenAt));

  const books = [...profile.books]
    .map((b) => ({ bookId: b.bookId, status: b.status, startedAt: b.startedAt, stage: b.stage }))
    .sort((a, b) => byTimeDesc(b.startedAt, a.startedAt)); // 开始得早的排前面

  return { lines, ahead, books };
}

/**
 * 同一个命题上「还有谁说过」（docs/05 §3.3 交叉印证）：
 * 候选 = 内容层里已上架（status active）、说的是同一个命题、且他还没打开过的书。
 * v1 只有一本书 ⇒ 恒为空数组；这不是待办，是**远处那座塔**（§8.1），
 * 所以调用方只在「他这条线已经走到 mastered」时才拿出来邀请，不到就不提。
 */
export function inviteBooksFor(
  topic: TopicId,
  profile: Pick<GrowthProfile, 'books'>
): BookMeta[] {
  const opened = new Set(profile.books.map((b) => b.bookId));
  return getBooks().filter((b) => b.status === 'active' && !opened.has(b.id) && b.topics.includes(topic));
}
