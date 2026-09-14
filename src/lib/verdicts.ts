// 6 节点的答卷：读取端（docs/10 P0-2）。
//
// 写端在 `/api/journey/close`（一格提交后写 `events(name='node_verdict')`），这里只做两件事：
// ① 把那批**指针**读回来，拼成一个人能看的答卷；② 按 `20-1` 的判定表**读**出三态结论。
//
// 三个纪律，每一条都对应下面一段代码：
// - **只读实际值，不算达标线**。`20-1` 里 ≥70%/≥60%/≥40%/1.5× 与反指标 30% 全是推断、
//   无出处（docs/10 已登记），第一轮的做法是只记分布，跑完 D14 用实际分布回填阈值。
//   所以这里没有一个百分比判定，也不该有。
// - **不把 `pending` 当 `no`**。只有一层达标＝机制空转，空转要靠下一个节点复现来坐实；
//   拿一个人一天的一句话去收官整轮验证，是把验证跑成了 KPI。
// - **提前收官必须写明"这次验证没回答什么"**。收官是对整轮下结论，漏掉没答的那几个问题，
//   结论就会读起来比实际更大——`UNANSWERED` 就是给这件事留的位置。
//
// 注意口径：这里判的是**机制**，不是人。`no` 的意思是"这条路对这个人、这个阶段没走通"，
// 不是"他不行"。文案出口在本文件之外，别把结论写成评价。
import { ensureSchema, execWithFailover, iso } from '@/lib/db';
import { isVerdictNode, type VerdictNode } from '@/lib/cognition';

/** `events.node_verdict` 一行（`metadata` 是 JSONB，读回来的是 unknown） */
export interface NodeVerdictRow {
  userKey: string;
  node: VerdictNode;
  verdict: 'yes' | 'no' | 'pending';
  behaviorOk: boolean;
  cognitionOk: boolean;
  /** 依据指针：能照 (topic, at) 回到 `threads[].evidence` 里他说的那一句；没填③就是 null */
  basisTopic: string | null;
  basisAt: string | null;
  source: 'touch' | 'app';
  /** 交这一格的那天（UTC ISO）。跟 `user_started_at` 一起算"第几天" */
  at: string;
}

function rowToVerdict(row: Record<string, unknown>): NodeVerdictRow | null {
  const meta = (row.metadata as Record<string, unknown> | null) ?? {};
  const node = meta.node;
  // 认不出的节点直接丢：宁可少一行，也不让一个写坏的 meta 变成一条假结论
  if (!isVerdictNode(node)) return null;
  const verdict = meta.verdict;
  return {
    userKey: String(row.user_key),
    node,
    verdict: verdict === 'yes' || verdict === 'no' || verdict === 'pending' ? verdict : 'pending',
    behaviorOk: meta.behavior_ok === true,
    cognitionOk: meta.cognition_ok === true,
    basisTopic: typeof meta.basis_topic === 'string' ? meta.basis_topic : null,
    basisAt: typeof meta.basis_at === 'string' ? meta.basis_at : null,
    source: meta.source === 'touch' ? 'touch' : 'app',
    at: iso(row.created_at),
  };
}

/**
 * 某个用户（或全体）的节点答卷，按时间正序。
 * `userKey` 不给就取全体——验证阶段要看的是分布，不是某个人的明细。
 */
export async function listNodeVerdicts(params: { userKey?: string; limit?: number } = {}): Promise<NodeVerdictRow[]> {
  await ensureSchema();
  const limit = params.limit ?? 500;
  const rows = await execWithFailover((sql) =>
    params.userKey
      ? sql`SELECT user_key, metadata, created_at FROM events
            WHERE name = 'node_verdict' AND user_key = ${params.userKey}
            ORDER BY created_at ASC LIMIT ${limit}`
      : sql`SELECT user_key, metadata, created_at FROM events
            WHERE name = 'node_verdict'
            ORDER BY created_at ASC LIMIT ${limit}`
  );
  return rows.map(rowToVerdict).filter((r): r is NodeVerdictRow => r !== null);
}

/** 一个用户的整轮验证读数（读取端现算，不落库——阈值改了立刻生效） */
export interface NodeVerdictSummary {
  /** 交出过答卷的节点，按时间正序（同节点多次只留最后一次） */
  answered: NodeVerdictRow[];
  /** 走得最远的那个节点（`VERDICT_NODES` 顺序里的最后一个） */
  furthest: VerdictNode | null;
  /** 读出来的三态。只有真答过才不是 `none` */
  state: 'yes' | 'no' | 'pending' | 'none';
  /**
   * 收敛速度（成功信号，`20-1` 要的那个）：第一次达标是**第几个节点**。
   * 给的是节点序号（1 起）而不是天数——节点日与自然日不是一回事，
   * 混着报会看起来比实际准。
   */
  convergedAtNode: number | null;
  /**
   * 若 `state === 'no'`：这次收官**没回答**什么（docs/10 §2.2）。
   * 别的状态为空——没收官就不需要交代没答什么。
   */
  unanswered: string[];
}

/**
 * 每个节点**问的到底是什么问题**，以及它在整轮验证里代表哪一步。
 * 收官要写的"没回答什么"就是从这张表里减出来的：没走到他后面的节点，就是没答的问题。
 */
const NODE_MEANS: Record<VerdictNode, string> = {
  D7: '有没有真的开始',
  D14: '机制成不成立（行为层 × 认知层成对看，主判断点）',
  D21: '能不能断奶（不靠推送还在做）',
  D30: '认知有没有稳定方向（说法是否收敛）',
  D66: '行为自动化了没有（有没有变成习惯）',
  D90: '值不值得续',
};

export function summarizeNodeVerdicts(rows: NodeVerdictRow[]): NodeVerdictSummary {
  // 同节点多次提交：留最后一次。同一天反复改主意不该被算成两个答案，
  // 而"改了"本身是信息——所以留最后，不是留第一个。
  const byNode = new Map<VerdictNode, NodeVerdictRow>();
  for (const row of rows) byNode.set(row.node, row);
  const answered = [...byNode.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  if (answered.length === 0) {
    return { answered, furthest: null, state: 'none', convergedAtNode: null, unanswered: [] };
  }

  const order = ['D7', 'D14', 'D21', 'D30', 'D66', 'D90'] as const;
  const furthest = answered.reduce(
    (last, row) => (order.indexOf(row.node) > order.indexOf(last) ? row.node : last),
    answered[0].node
  );

  // 三态取**最后一次**答卷：`20-1` 的判定点是当下这条路通不通，不是历史最高分。
  const latest = answered[answered.length - 1];
  const state = latest.verdict;

  // 收敛速度：第一次出现 `yes` 是第几个节点
  let convergedAtNode: number | null = null;
  for (const row of answered) {
    if (row.verdict === 'yes') {
      convergedAtNode = order.indexOf(row.node) + 1;
      break;
    }
  }

  const unanswered =
    state === 'no'
      ? order.filter((n) => order.indexOf(n) > order.indexOf(furthest)).map((n) => `${n}：${NODE_MEANS[n]}`)
      : [];

  return { answered, furthest, state, convergedAtNode, unanswered };
}
