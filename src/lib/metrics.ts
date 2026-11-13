// 机制仪表（2026-11-13，编码侧提案·用户拍板「按建议顺序实现」）：验证期的眼睛。
//
// 为什么有这个文件：M1-M11 之后，漏斗数据（L1 做 → L2 说 → L3 续 → L4/L5/M →
// 评估 → 六节点）全部落在 `events` / `growth_profiles`，但唯一读取口是
// `/api/touch/verdicts`（secret 闸、只看节点）。验证期的目的是「验证机制」
// （20-1 判定表：行为层 × 认知层成对），没有一双眼睛，跑完也读不出结论。
//
// 三条纪律（继承 verdicts.ts 的口径）：
// - **只读实际值，不算达标线**：没有一个百分比判定，分布本身是结论。
// - **不改任何业务数据**：本文件全部 SELECT，零写入。
// - **北极星原样呈现**：「周完成 ≥3 步的用户占比」（docs/02 §16.4），
//   ratio 只是 achieved/active，不是判定。
import { ensureSchema, execWithFailover } from '@/lib/db';
import { listNodeVerdicts, type NodeVerdictRow } from '@/lib/verdicts';
import { VERDICT_NODES } from '@/lib/cognition';

/** 安全的比值：分母 0 → null（别把 0/0 读成 0%，"没人"和"全都没做到"是两回事）。
 *  负数 / NaN / Infinity 一律 null——仪表宁可空着，不给坏数据一个像样的形状。 */
export function ratioOf(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (numerator < 0 || denominator <= 0) return null;
  return numerator / denominator;
}

export interface NodeVerdictBucket {
  node: string;
  yes: number;
  no: number;
  pending: number;
  /** 从信里回来的答卷数（source='touch'）——归因链修好之前这里永远是 0 */
  fromTouch: number;
  total: number;
}

/**
 * 六节点三态分布（纯函数，单测钉口径）：每个节点一行，yes/no/pending/fromTouch 计数。
 * 没人答的节点也保留（全 0 行）——验证期看的是"哪些节点还没人到"，缺行会读成"都答了"。
 */
export function aggregateNodeVerdicts(rows: NodeVerdictRow[]): NodeVerdictBucket[] {
  const order = VERDICT_NODES as readonly string[];
  const buckets = new Map<string, NodeVerdictBucket>(
    order.map((node) => [node, { node, yes: 0, no: 0, pending: 0, fromTouch: 0, total: 0 }]),
  );
  for (const row of rows) {
    const b = buckets.get(row.node);
    if (!b) continue; // 认不出的节点丢弃（listNodeVerdicts 已滤，这里兜底）
    b.total += 1;
    if (row.verdict === 'yes') b.yes += 1;
    else if (row.verdict === 'no') b.no += 1;
    else b.pending += 1;
    if (row.source === 'touch') b.fromTouch += 1;
  }
  return [...buckets.values()];
}

export interface TouchNodeCount {
  node: string;
  sent: number;
  returned: number;
}

/** 触达分桶（纯函数）：把 sent / return 两份 per-node 计数并成一张表。 */
export function mergeTouchCounts(
  sentRows: { node: string; n: number }[],
  returnRows: { node: string; n: number }[],
): TouchNodeCount[] {
  const map = new Map<string, TouchNodeCount>();
  for (const r of sentRows) {
    const cur = map.get(r.node) ?? { node: r.node, sent: 0, returned: 0 };
    cur.sent += r.n;
    map.set(r.node, cur);
  }
  for (const r of returnRows) {
    const cur = map.get(r.node) ?? { node: r.node, sent: 0, returned: 0 };
    cur.returned += r.n;
    map.set(r.node, cur);
  }
  return [...map.values()].sort(
    (a, b) => Number(a.node.slice(1) || 0) - Number(b.node.slice(1) || 0),
  );
}

export interface MechanismSnapshot {
  generatedAt: string;
  scale: {
    profiles: number;
    new30d: number;
    withPortrait: number;
  };
  /** 北极星：周完成 ≥3 步的用户占比（docs/02 §16.4） */
  northStar: {
    achievedUsers: number;
    activeUsers: number;
    ratio: number | null;
  };
  /** L1 做：近 30 天交过的格（用户 × 天去重）与交过格的人 */
  close30d: { closeDays: number; closeUsers: number };
  /** L2 说（被看见率）：交格当天也有对话的天数占比 */
  seen30d: { closeDays: number; seenDays: number; ratio: number | null };
  /** L3 续：交格次日回访的天数占比 */
  nextDay30d: { closeDays: number; nextDays: number; ratio: number | null };
  /** L4/L5/M 认知层事件（近 30 天；events 只存枚举，无文本） */
  cognition30d: { name: string; n: number; users: number }[];
  /** 评估与画像演进（近 30 天） */
  assessment30d: { name: string; n: number }[];
  /** 触达：近 180 天 per-node 发出/回程 */
  touch: { totalSent: number; totalReturned: number; ratio: number | null; perNode: TouchNodeCount[] };
  /** 六节点答卷三态分布 */
  nodes: NodeVerdictBucket[];
}

/** 行集 → name 索引的计数字典 */
function countByName(rows: Record<string, unknown>[]): Map<string, { n: number; users: number }> {
  const map = new Map<string, { n: number; users: number }>();
  for (const r of rows) {
    map.set(String(r.name), { n: Number(r.n) || 0, users: Number(r.users) || 0 });
  }
  return map;
}

function perNodeRows(rows: Record<string, unknown>[]): { node: string; n: number }[] {
  return rows.map((r) => ({ node: String(r.node), n: Number(r.n) || 0 }));
}

/** 全量快照（RSC / admin 页直接调用）。任何一段查询失败都让整页报错——
 *  仪表是给人看的，半张脸的仪表比没有仪表更危险。 */
export async function getMechanismSnapshot(): Promise<MechanismSnapshot> {
  await ensureSchema();

  const [scaleRow] = await execWithFailover((sql) =>
    sql`SELECT
          (SELECT count(*)::int FROM growth_profiles) AS profiles,
          (SELECT count(*)::int FROM growth_profiles WHERE created_at >= now() - interval '30 days') AS new30d,
          (SELECT count(DISTINCT user_key)::int FROM events WHERE name = 'portrait_done') AS withPortrait`,
  );

  const [northStarRow] = await execWithFailover((sql) =>
    sql`WITH steps AS (
          SELECT user_key, (created_at AT TIME ZONE 'UTC')::date AS d
          FROM events
          WHERE name = 'day_close_saved' AND created_at >= now() - interval '7 days'
          GROUP BY user_key, d
        ), per_user AS (
          SELECT user_key, count(*)::int AS days FROM steps GROUP BY user_key
        )
        SELECT count(*) FILTER (WHERE days >= 3)::int AS achieved,
               count(*)::int AS active
        FROM per_user`,
  );

  const [closeRow] = await execWithFailover((sql) =>
    sql`WITH days AS (
          SELECT DISTINCT user_key, (created_at AT TIME ZONE 'UTC')::date AS d
          FROM events
          WHERE name = 'day_close_saved' AND created_at >= now() - interval '30 days'
        )
        SELECT count(*)::int AS close_days, count(DISTINCT user_key)::int AS close_users FROM days`,
  );

  const [seenRow] = await execWithFailover((sql) =>
    sql`WITH closes AS (
          SELECT DISTINCT user_key, (created_at AT TIME ZONE 'UTC')::date AS d
          FROM events
          WHERE name = 'day_close_saved' AND created_at >= now() - interval '30 days'
        ), chats AS (
          SELECT DISTINCT user_key, (created_at AT TIME ZONE 'UTC')::date AS d
          FROM events
          WHERE name = 'chat_session_started' AND created_at >= now() - interval '30 days'
        )
        SELECT count(*)::int AS close_days,
               count(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM chats h WHERE h.user_key = c.user_key AND h.d = c.d
               ))::int AS seen_days
        FROM closes c`,
  );

  const [nextRow] = await execWithFailover((sql) =>
    sql`WITH closes AS (
          SELECT DISTINCT user_key, (created_at AT TIME ZONE 'UTC')::date AS d
          FROM events
          WHERE name = 'day_close_saved' AND created_at >= now() - interval '30 days'
        ), visits AS (
          SELECT DISTINCT user_key, (created_at AT TIME ZONE 'UTC')::date AS d
          FROM events
          WHERE name = 'journey_visit' AND created_at >= now() - interval '31 days'
        )
        SELECT count(*)::int AS close_days,
               count(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM visits v WHERE v.user_key = c.user_key AND v.d = c.d + 1
               ))::int AS next_days
        FROM closes c`,
  );

  const cogRows = await execWithFailover((sql) =>
    sql`SELECT name, count(*)::int AS n, count(DISTINCT user_key)::int AS users
        FROM events
        WHERE name IN ('cognition_pause', 'cognition_regress', 'cognition_migrate_proposed',
                       'cognition_migrate_kept', 'cognition_migrate_undone')
          AND created_at >= now() - interval '30 days'
        GROUP BY name`,
  );

  const assessRows = await execWithFailover((sql) =>
    sql`SELECT name, count(*)::int AS n
        FROM events
        WHERE name IN ('stage_assessment_proposal_seen', 'stage_assessment_confirmed',
                       'stage_advanced', 'evolve_proposal_seen', 'portrait_evolved',
                       'first_echo_shown')
          AND created_at >= now() - interval '30 days'
        GROUP BY name`,
  );

  const sentRows = await execWithFailover((sql) =>
    sql`SELECT metadata->>'node' AS node, count(*)::int AS n
        FROM events
        WHERE name = 'touch_sent' AND created_at >= now() - interval '180 days'
        GROUP BY 1`,
  );
  const returnRows = await execWithFailover((sql) =>
    sql`SELECT metadata->>'node' AS node, count(*)::int AS n
        FROM events
        WHERE name = 'touch_return' AND created_at >= now() - interval '180 days'
        GROUP BY 1`,
  );

  const verdictRows = await listNodeVerdicts({ limit: 1000 });

  const cog = countByName(cogRows as Record<string, unknown>[]);
  const cognition30d = ['cognition_pause', 'cognition_regress', 'cognition_migrate_proposed', 'cognition_migrate_kept', 'cognition_migrate_undone'].map(
    (name) => ({ name, n: cog.get(name)?.n ?? 0, users: cog.get(name)?.users ?? 0 }),
  );
  const assessMap = countByName(assessRows as Record<string, unknown>[]);
  const assessment30d = ['first_echo_shown', 'stage_assessment_proposal_seen', 'stage_assessment_confirmed', 'stage_advanced', 'evolve_proposal_seen', 'portrait_evolved'].map(
    (name) => ({ name, n: assessMap.get(name)?.n ?? 0 }),
  );

  const perNode = mergeTouchCounts(
    perNodeRows(sentRows as Record<string, unknown>[]),
    perNodeRows(returnRows as Record<string, unknown>[]),
  );
  const totalSent = perNode.reduce((a, b) => a + b.sent, 0);
  const totalReturned = perNode.reduce((a, b) => a + b.returned, 0);

  return {
    generatedAt: new Date().toISOString(),
    scale: {
      profiles: Number(scaleRow.profiles) || 0,
      new30d: Number(scaleRow.new30d) || 0,
      withPortrait: Number(scaleRow.withPortrait) || 0,
    },
    northStar: {
      achievedUsers: Number(northStarRow.achieved) || 0,
      activeUsers: Number(northStarRow.active) || 0,
      ratio: ratioOf(Number(northStarRow.achieved) || 0, Number(northStarRow.active) || 0),
    },
    close30d: {
      closeDays: Number(closeRow.close_days) || 0,
      closeUsers: Number(closeRow.close_users) || 0,
    },
    seen30d: {
      closeDays: Number(seenRow.close_days) || 0,
      seenDays: Number(seenRow.seen_days) || 0,
      ratio: ratioOf(Number(seenRow.seen_days) || 0, Number(seenRow.close_days) || 0),
    },
    nextDay30d: {
      closeDays: Number(nextRow.close_days) || 0,
      nextDays: Number(nextRow.next_days) || 0,
      ratio: ratioOf(Number(nextRow.next_days) || 0, Number(nextRow.close_days) || 0),
    },
    cognition30d,
    assessment30d,
    touch: { totalSent, totalReturned, ratio: ratioOf(totalReturned, totalSent), perNode },
    nodes: aggregateNodeVerdicts(verdictRows),
  };
}
