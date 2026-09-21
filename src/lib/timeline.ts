// 成长足迹（M9 需求①「和用户有关的内容整合到旅程中，方便查看」）：把散落在
// 各处的用户内容归并成一条时间线。不是数据相册，是改变的见证——书中「看见 /
// 松动 / 练习 / 活法」的每一步都值得回头看见。
// 七源：会话摘要 memory / 日记 journal / 信件 letter / 微行动 experiment /
// 心印 stamp / 画像版本 portrait / 绕开 avoided（V0.2 尾批 O8——只进回看的事实行）。
// 归并排序是纯函数，DB 读取只在 buildTimeline。
import { getProfile, type GrowthProfile } from '@/lib/profile';
import { getJournalEntries } from '@/lib/journal';
import { listPortraitVersions } from '@/lib/evolution';
import { getSql } from './db';

export type TimelineItem =
  | { kind: 'memory'; date: string; text: string; sessionId: string | null }
  | { kind: 'journal'; id: number; date: string; text: string; aiReply: string | null }
  | { kind: 'letter'; date: string; stage: number; text: string; state: 'kept' | 'sealed' | 'opened' }
  | { kind: 'experiment'; date: string; action: string; feeling: string | null }
  | { kind: 'portrait'; date: string; version: number; source: string; current: boolean }
  | { kind: 'stamp'; date: string; stampKind: string; earnedAt: string }
  /** 「他绕开的」（V0.2 尾批 O8）：那天跳过/换一个/第③问留空的事实，只进回看，事实表述不是评估 */
  | { kind: 'avoided'; date: string; facts: AvoidedFact[] };

export type AvoidedFact = 'skip' | 'swap' | 'thought';

/** 同日稳定序：心印（仪式时刻）> 会话摘要 > 日记 > 信 > 微行动 > 画像 > 绕开（最轻，垫底） */
const KIND_ORDER: Record<TimelineItem['kind'], number> = {
  stamp: 0,
  memory: 1,
  journal: 2,
  letter: 3,
  experiment: 4,
  portrait: 5,
  avoided: 6,
};

const day = (iso: string): string => iso.slice(0, 10);

/** 排序：date 倒序，同日按 KIND_ORDER（Array.sort 稳定，同权重保持插入序）后截断 */
export function mergeTimelineItems(items: TimelineItem[], limit = 100): TimelineItem[] {
  const sorted = [...items].sort((a, b) =>
    a.date === b.date ? KIND_ORDER[a.kind] - KIND_ORDER[b.kind] : a.date < b.date ? 1 : -1
  );
  return sorted.slice(0, limit);
}

/**
 * 档案 → 时间线节点（纯函数）。画像当前版优先用 portrait_versions 的行（有
 * source/material），表里还没有（存量用户未到首次演进、未懒回填）才用
 * profile.portrait 兜底出一个节点，两者不会重复。封存的信不带正文——
 * 「封存」是用户此刻选择不看，时间线尊重它，只留一封"等你愿意打开"的痕。
 */
export function itemsFromProfile(profile: GrowthProfile, knownVersions: number[] = []): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const m of profile.memories) {
    items.push({ kind: 'memory', date: day(m.date), text: m.text, sessionId: m.sessionId ?? null });
  }
  for (const e of profile.experiments) {
    items.push({ kind: 'experiment', date: day(e.date), action: e.action, feeling: e.feeling ?? null });
  }
  for (const l of profile.letters) {
    items.push({
      kind: 'letter',
      date: day(l.createdAt),
      stage: l.stage,
      text: l.state === 'sealed' ? '' : l.content,
      state: l.state,
    });
  }
  for (const s of profile.stamps) {
    items.push({ kind: 'stamp', date: day(s.earnedAt), stampKind: s.kind, earnedAt: s.earnedAt });
  }
  const p = profile.portrait;
  if (p && !knownVersions.includes(p.version)) {
    items.push({
      kind: 'portrait',
      // 存量 v1 无 createdAt → 用档案创建日兜底（演进基线同一条优先链，见计划）
      date: day(p.createdAt ?? profile.created_at),
      version: p.version,
      source: 'onboarding',
      current: true,
    });
  }
  return items;
}

/** 拉全六源并归并（RSC 直调；timeline 页与 journey「旅程中的我」预览共用） */
export async function buildTimeline(userKey: string, limit = 100, journalLimit = 100): Promise<TimelineItem[]> {
  const profile = await getProfile(userKey);
  const versions = await listPortraitVersions(userKey);
  const currentVersion = profile?.portrait?.version ?? -1;
  const items: TimelineItem[] = profile ? itemsFromProfile(profile, versions.map((v) => v.version)) : [];
  for (const v of versions) {
    items.push({
      kind: 'portrait',
      date: day(v.createdAt),
      version: v.version,
      source: v.source,
      current: v.version === currentVersion,
    });
  }
  // 日记不依赖档案（游客也能写），单独拉
  const journals = await getJournalEntries(userKey, journalLimit);
  for (const j of journals) {
    items.push({ kind: 'journal', date: day(j.createdAt), id: j.id, text: j.content, aiReply: j.aiReply });
  }
  // 「他绕开的」（O8）：events 里已有的两笔（act_avoided / day_close_saved.thought=false），
  // 零新增采集面——回看时那天的绕开也有痕，事实表述不是评估
  const avoided = await getAvoidedEvents(userKey);
  items.push(...avoidedItemsFromEvents(avoided));
  return mergeTimelineItems(items, limit);
}

/** events 里与「绕开」有关的两类行（day 已在 SQL 侧转成 UTC 日期文本，避开 timestamptz→Date 坑） */
export interface AvoidedEventRow {
  name: string;
  metadata: Record<string, unknown> | null;
  day: string;
}

/**
 * events → 「绕开」时间线节点（纯函数）。同日多笔合并成一个节点、facts 去重——
 * 一天一行轻事实，不陈列次数、不打分。thought 只认显式 false（第③问留空的口径
 * 由 close 侧 day_close_saved 落定，这里不做推断）。
 */
export function avoidedItemsFromEvents(rows: AvoidedEventRow[]): TimelineItem[] {
  const FACT_ORDER: AvoidedFact[] = ['skip', 'swap', 'thought'];
  const byDay = new Map<string, Set<AvoidedFact>>();
  for (const row of rows) {
    const facts = byDay.get(row.day) ?? new Set<AvoidedFact>();
    if (row.name === 'act_avoided') {
      const kind = row.metadata?.kind;
      if (kind === 'skip' || kind === 'swap') facts.add(kind);
    } else if (row.name === 'day_close_saved') {
      const thought = row.metadata?.thought;
      if (thought === false || thought === 'false') facts.add('thought');
    }
    byDay.set(row.day, facts);
  }
  return [...byDay.entries()]
    .filter(([, facts]) => facts.size > 0)
    .map(([date, facts]) => ({ kind: 'avoided' as const, date, facts: FACT_ORDER.filter((f) => facts.has(f)) }));
}

/** 拉某用户与「绕开」相关的 events（SQL 侧就按两类名字 + thought=false 收窄） */
async function getAvoidedEvents(userKey: string): Promise<AvoidedEventRow[]> {
  try {
    const rows = await getSql()`
      SELECT name, metadata, created_at::date::text AS day
      FROM events
      WHERE user_key = ${userKey}
        AND (name = 'act_avoided' OR (name = 'day_close_saved' AND metadata->>'thought' = 'false'))
      ORDER BY created_at DESC
      LIMIT 300
    `;
    return rows.map((r) => ({
      name: String(r.name),
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      day: String(r.day),
    }));
  } catch (error) {
    console.error('[timeline] getAvoidedEvents failed:', error);
    return []; // 绕开痕读不出就当没有——回看绝不因它挂掉
  }
}

/** 服务端日期本地化（固定 UTC 时区，避免服务器时区把日期偏移一天） */
export function formatTimelineDay(locale: string, date: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${date}T00:00:00Z`));
  } catch {
    return date;
  }
}
