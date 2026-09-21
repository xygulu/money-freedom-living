import { describe, expect, it } from 'vitest';
import { avoidedItemsFromEvents, mergeTimelineItems, itemsFromProfile, type TimelineItem } from '@/lib/timeline';
import type { GrowthProfile, Portrait } from '@/lib/profile';

const portrait = (over: Partial<Portrait> = {}): Portrait => ({
  spoken: ['我一花钱就心虚'],
  baseColor: '你总觉得自己不配',
  moments: [{ title: '发工资那天', detail: '先还花呗' }],
  script: '你可能觉得钱是要还的债',
  toFuture: '希望你能松弛一点',
  version: 1,
  calibrations: [],
  scriptStatus: 'pending',
  ...over,
});

const profile = (over: Partial<GrowthProfile> = {}): GrowthProfile => ({
  user_key: 'u:test',
  locale: 'zh-CN',
  portrait: null,
  concerns: [],
  stage: 1,
  stage_started_at: '2026-09-01T00:00:00Z',
  pinned: [],
  memories: [],
  experiments: [],
  letters: [],
  stamps: [],
  evolution: { dismissedAt: null, lastGeneratedAt: null, proposedSeenAt: null, generatingAt: null },
  assessment: { pending: null, confirmed: null, confirmedAt: null, dismissedAt: null, generatingAt: null, proposedSeenAt: null },
  created_at: '2026-08-01T00:00:00Z',
  dailySeen: [],
  payday: null,
  total_active_days: 3,
  last_active_date: '2026-09-10',
  books: [],
  wished_books: [],
  threads: {},
  touch: {},
  ...over,
});

describe('mergeTimelineItems（归并排序纯函数）', () => {
  it('date 倒序：新的在前', () => {
    const items: TimelineItem[] = [
      { kind: 'journal', id: 1, date: '2026-09-01', text: '旧', aiReply: null },
      { kind: 'journal', id: 2, date: '2026-09-10', text: '新', aiReply: null },
      { kind: 'journal', id: 3, date: '2026-09-05', text: '中', aiReply: null },
    ];
    expect(mergeTimelineItems(items).map((i) => (i.kind === 'journal' ? i.id : -1))).toEqual([2, 3, 1]);
  });

  it('同日稳定序：stamp > memory > journal > letter > experiment > portrait', () => {
    const items: TimelineItem[] = [
      { kind: 'portrait', date: '2026-09-10', version: 1, source: 'onboarding', current: true },
      { kind: 'experiment', date: '2026-09-10', action: 'a', feeling: null },
      { kind: 'letter', date: '2026-09-10', stage: 1, text: 'l', state: 'kept' },
      { kind: 'journal', id: 1, date: '2026-09-10', text: 'j', aiReply: null },
      { kind: 'memory', date: '2026-09-10', text: 'm', sessionId: null },
      { kind: 'stamp', date: '2026-09-10', stampKind: 'stage1_story', earnedAt: '2026-09-10T08:00:00Z' },
    ];
    expect(mergeTimelineItems(items).map((i) => i.kind)).toEqual([
      'stamp', 'memory', 'journal', 'letter', 'experiment', 'portrait',
    ]);
  });

  it('同日同源保持插入序（稳定排序）', () => {
    const items: TimelineItem[] = [3, 1, 2].map((id) => ({
      kind: 'journal' as const, id, date: '2026-09-10', text: String(id), aiReply: null,
    }));
    expect(mergeTimelineItems(items).map((i) => (i as { id: number }).id)).toEqual([3, 1, 2]);
  });

  it('limit 截断取最新的 n 条', () => {
    const items: TimelineItem[] = Array.from({ length: 10 }, (_, i) => ({
      kind: 'journal' as const, id: i, date: `2026-09-${String(i + 1).padStart(2, '0')}`, text: '', aiReply: null,
    }));
    const merged = mergeTimelineItems(items, 3);
    expect(merged).toHaveLength(3);
    expect(merged[0]?.date).toBe('2026-09-10');
  });
});

describe('itemsFromProfile（档案 → 节点）', () => {
  it('六源全部映射；缺 sessionId 的存量摘要渲染为不可点（null）；ISO 归一到日期', () => {
    const p = profile({
      portrait: portrait({ version: 1, createdAt: '2026-08-02T12:00:00Z' }),
      memories: [{ date: '2026-09-03', text: '聊到小时候的账本', sessionId: 'sid-1' }, { date: '2026-09-01', text: '更早的一次' }],
      experiments: [{ date: '2026-09-04', action: '给自己买了一束花', feeling: '心虚，但买了' }],
      letters: [{ stage: 1, content: '亲爱的钱', state: 'kept', aiReply: null, createdAt: '2026-09-05T10:00:00Z' }],
      stamps: [{ kind: 'stage1_story', earnedAt: '2026-09-06T09:30:00Z' }],
    });
    const items = itemsFromProfile(p, []);
    expect(items).toHaveLength(6);
    const memory = items.find((i) => i.kind === 'memory');
    expect(memory && memory.kind === 'memory' && memory.sessionId).toBe('sid-1');
    const legacy = items.filter((i) => i.kind === 'memory')[1];
    expect(legacy && legacy.kind === 'memory' && legacy.sessionId).toBeNull();
    const stamp = items.find((i) => i.kind === 'stamp');
    expect(stamp?.date).toBe('2026-09-06'); // earnedAt ISO → 日期
  });

  it('封存的信不带正文（封存=用户此刻选择不看），kept/opened 带正文', () => {
    const p = profile({
      letters: [
        { stage: 1, content: '秘密', state: 'sealed', aiReply: null, createdAt: '2026-09-05T10:00:00Z' },
        { stage: 1, content: '普通', state: 'kept', aiReply: null, createdAt: '2026-09-06T10:00:00Z' },
      ],
    });
    const items = itemsFromProfile(p);
    const sealed = items.find((i) => i.kind === 'letter' && i.state === 'sealed');
    const kept = items.find((i) => i.kind === 'letter' && i.state === 'kept');
    expect(sealed && sealed.kind === 'letter' && sealed.text).toBe('');
    expect(kept && kept.kind === 'letter' && kept.text).toBe('普通');
  });

  it('存量用户：portrait_versions 没有行时，用 profile.portrait 兜底出画像节点，日期走 createdAt → created_at', () => {
    const withCreatedAt = itemsFromProfile(profile({ portrait: portrait({ createdAt: '2026-08-02T00:00:00Z' }) }));
    expect(withCreatedAt.some((i) => i.kind === 'portrait' && i.date === '2026-08-02' && i.current)).toBe(true);
    const legacy = itemsFromProfile(profile({ portrait: portrait() })); // 无 createdAt
    const node = legacy.find((i) => i.kind === 'portrait');
    expect(node?.date).toBe('2026-08-01'); // 兜底 profile.created_at
  });

  it('版本行已收录该版时不再兜底出重复画像节点', () => {
    const p = profile({ portrait: portrait({ version: 1 }) });
    expect(itemsFromProfile(p, [1]).filter((i) => i.kind === 'portrait')).toHaveLength(0);
    expect(itemsFromProfile(p, [2]).filter((i) => i.kind === 'portrait')).toHaveLength(1);
  });

  it('空档案 → 空数组', () => {
    expect(itemsFromProfile(profile())).toEqual([]);
  });
});

describe('avoidedItemsFromEvents（「他绕开的」V0.2 尾批 O8）', () => {
  const ev = (name: string, metadata: Record<string, unknown> | null, day: string) => ({ name, metadata, day });

  it('同日 skip+swap+thought 合并成一个节点，facts 按稳定序', () => {
    const items = avoidedItemsFromEvents([
      ev('day_close_saved', { did: 'done', thought: false, pause: false }, '2026-09-20'),
      ev('act_avoided', { kind: 'swap' }, '2026-09-20'),
      ev('act_avoided', { kind: 'skip' }, '2026-09-20'),
    ]);
    expect(items).toEqual([{ kind: 'avoided', date: '2026-09-20', facts: ['skip', 'swap', 'thought'] }]);
  });

  it('同日重复同款事件去重——一天一行轻事实，不陈列次数', () => {
    const items = avoidedItemsFromEvents([
      ev('act_avoided', { kind: 'skip' }, '2026-09-20'),
      ev('act_avoided', { kind: 'skip' }, '2026-09-20'),
    ]);
    expect(items).toEqual([{ kind: 'avoided', date: '2026-09-20', facts: ['skip'] }]);
  });

  it('thought 只认显式 false（boolean 或 jsonb 文本），true/缺失不入', () => {
    const items = avoidedItemsFromEvents([
      ev('day_close_saved', { did: 'done', thought: true }, '2026-09-19'),
      ev('day_close_saved', { did: 'done', thought: false }, '2026-09-18'),
      ev('day_close_saved', { did: 'done', thought: 'false' }, '2026-09-17'),
      ev('day_close_saved', { did: 'done' }, '2026-09-16'),
    ]);
    expect(items.map((i) => i.date)).toEqual(['2026-09-18', '2026-09-17']);
  });

  it('非法 kind / 无关事件名丢弃；不同日各成一行', () => {
    const items = avoidedItemsFromEvents([
      ev('act_avoided', { kind: 'other' }, '2026-09-20'),
      ev('companion_nudge', { source: 'L1' }, '2026-09-20'),
      ev('act_avoided', { kind: 'swap' }, '2026-09-19'),
    ]);
    expect(items).toEqual([{ kind: 'avoided', date: '2026-09-19', facts: ['swap'] }]);
  });

  it('空输入 → 空数组', () => {
    expect(avoidedItemsFromEvents([])).toEqual([]);
  });

  it('同日排序里 avoided 垫底（最轻）', () => {
    const items = mergeTimelineItems([
      { kind: 'avoided', date: '2026-09-10', facts: ['skip'] },
      { kind: 'stamp', date: '2026-09-10', stampKind: 'stage1_story', earnedAt: '2026-09-10T08:00:00Z' },
    ]);
    expect(items[0].kind).toBe('stamp');
    expect(items[1].kind).toBe('avoided');
  });
});
