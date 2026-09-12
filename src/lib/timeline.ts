// 成长足迹（M9 需求①「和用户有关的内容整合到旅程中，方便查看」）：把散落在
// 各处的用户内容归并成一条时间线。不是数据相册，是改变的见证——书中「看见 /
// 松动 / 练习 / 活法」的每一步都值得回头看见。
// 六源：会话摘要 memory / 日记 journal / 信件 letter / 微行动 experiment /
// 心印 stamp / 画像版本 portrait。归并排序是纯函数，DB 读取只在 buildTimeline。
import { getProfile, type GrowthProfile } from '@/lib/profile';
import { getJournalEntries } from '@/lib/journal';
import { listPortraitVersions } from '@/lib/evolution';

export type TimelineItem =
  | { kind: 'memory'; date: string; text: string; sessionId: string | null }
  | { kind: 'journal'; id: number; date: string; text: string; aiReply: string | null }
  | { kind: 'letter'; date: string; stage: number; text: string; state: 'kept' | 'sealed' | 'opened' }
  | { kind: 'experiment'; date: string; action: string; feeling: string | null }
  | { kind: 'portrait'; date: string; version: number; source: string; current: boolean }
  | { kind: 'stamp'; date: string; stampKind: string; earnedAt: string };

/** 同日稳定序：心印（仪式时刻）> 会话摘要 > 日记 > 信 > 微行动 > 画像 */
const KIND_ORDER: Record<TimelineItem['kind'], number> = {
  stamp: 0,
  memory: 1,
  journal: 2,
  letter: 3,
  experiment: 4,
  portrait: 5,
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
  return mergeTimelineItems(items, limit);
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
