import { describe, expect, it } from 'vitest';
import {
  baselineFor,
  materialSince,
  shouldPropose,
  buildEvolveMessages,
  EVOLVE_MIN_MEMORIES,
  EVOLVE_MIN_DAYS,
  EVOLVE_DISMISS_COOLDOWN_DAYS,
} from '@/lib/evolution';
import type { GrowthProfile, Portrait } from '@/lib/profile';

const portrait = (over: Partial<Portrait> = {}): Portrait => ({
  spoken: ['我一花钱就心虚'],
  baseColor: '你总觉得自己不配',
  moments: [],
  script: '也许钱是要还的债',
  toFuture: '希望你能松弛一点',
  version: 1,
  calibrations: [],
  scriptStatus: 'pending',
  ...over,
});

const profile = (over: Partial<GrowthProfile> = {}): GrowthProfile => ({
  user_key: 'u:test',
  locale: 'zh-CN',
  portrait: portrait(),
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
  total_active_days: 0,
  last_active_date: null,
  books: [],
  threads: {},
  touch: {},
  ...over,
});

describe('baselineFor（演进基线优先链）', () => {
  it('版本行 created_at > portrait.createdAt > profile.created_at', () => {
    const p = profile({ portrait: portrait({ version: 2, createdAt: '2026-09-01T00:00:00Z' }), created_at: '2026-08-01T00:00:00Z' });
    expect(baselineFor(p, [{ version: 2, createdAt: '2026-09-10T00:00:00Z' }])).toBe('2026-09-10T00:00:00Z');
    expect(baselineFor(p, [])).toBe('2026-09-01T00:00:00Z');
    const legacy = profile({ portrait: portrait({ version: 1 }), created_at: '2026-08-01T00:00:00Z' });
    expect(baselineFor(legacy, [])).toBe('2026-08-01T00:00:00Z');
    const noCreatedAt = profile({ portrait: portrait({ version: 1, createdAt: undefined }) });
    expect(baselineFor(noCreatedAt, [{ version: 1, createdAt: '2026-09-05T00:00:00Z' }])).toBe('2026-09-05T00:00:00Z');
  });
});

describe('materialSince（基线后新素材计数）', () => {
  const base = '2026-09-01T12:00:00Z';
  it('严格晚于基线当天才算新素材（生成当天的初谈摘要已反映在该版里）', () => {
    const counts = materialSince(
      base,
      {
        memories: [{ date: '2026-09-01' }, { date: '2026-09-02' }, { date: '2026-09-03' }],
        journals: [{ createdAt: '2026-08-31T00:00:00Z' }, { createdAt: '2026-09-02T00:00:00Z' }],
        experiments: [{ date: '2026-09-01' }, { date: '2026-09-05' }],
      },
      '2026-09-20T00:00:00Z'
    );
    expect(counts).toEqual({ memories: 2, journals: 1, experiments: 1, daysSince: 18 });
  });

  it('nowISO 早于基线时 daysSince 不为负', () => {
    expect(materialSince(base, { memories: [], journals: [], experiments: [] }, '2026-08-30T00:00:00Z').daysSince).toBe(0);
  });
});

describe('shouldPropose（提议判定全分支）', () => {
  const now = '2026-10-30T00:00:00Z';

  it('无画像 → 永不提议', () => {
    const p = profile({ portrait: null });
    expect(shouldPropose(p, { memories: 99, journals: 99, experiments: 99, daysSince: 999 }, now)).toBe(false);
  });

  it(`新摘要 ≥${EVOLVE_MIN_MEMORIES} 条 → 提议（即使天数不足）`, () => {
    const p = profile();
    expect(shouldPropose(p, { memories: EVOLVE_MIN_MEMORIES, journals: 0, experiments: 0, daysSince: 1 }, now)).toBe(true);
    expect(shouldPropose(p, { memories: EVOLVE_MIN_MEMORIES - 1, journals: 0, experiments: 0, daysSince: 1 }, now)).toBe(false);
  });

  it(`距基线 ≥${EVOLVE_MIN_DAYS} 天且有任意新素材 → 提议；零素材不提议`, () => {
    const p = profile();
    expect(shouldPropose(p, { memories: 1, journals: 0, experiments: 0, daysSince: EVOLVE_MIN_DAYS }, now)).toBe(true);
    expect(shouldPropose(p, { memories: 0, journals: 2, experiments: 0, daysSince: EVOLVE_MIN_DAYS }, now)).toBe(true);
    expect(shouldPropose(p, { memories: 0, journals: 0, experiments: 0, daysSince: EVOLVE_MIN_DAYS }, now)).toBe(false);
    expect(shouldPropose(p, { memories: 2, journals: 0, experiments: 0, daysSince: EVOLVE_MIN_DAYS - 1 }, now)).toBe(false);
  });

  it('「暂不」冷却期内不提议，冷却期满恢复', () => {
    const dismissedAt = '2026-10-20T00:00:00Z';
    const p = profile({ evolution: { dismissedAt, lastGeneratedAt: null, proposedSeenAt: null, generatingAt: null } });
    const counts = { memories: EVOLVE_MIN_MEMORIES, journals: 0, experiments: 0, daysSince: 1 };
    // 冷却第 13 天（< 14 天）
    expect(shouldPropose(p, counts, '2026-11-02T00:00:00Z')).toBe(false);
    // 冷却期满（≥ 14 天）
    expect(shouldPropose(p, counts, '2026-11-03T12:00:00Z')).toBe(true);
    expect(EVOLVE_DISMISS_COOLDOWN_DAYS).toBe(14);
  });

  it('生成锁未过期不提议，过期（自愈）恢复判定', () => {
    const generatingAt = '2026-10-30T00:00:00Z';
    const p = profile({ evolution: { dismissedAt: null, lastGeneratedAt: null, proposedSeenAt: null, generatingAt } });
    const counts = { memories: EVOLVE_MIN_MEMORIES, journals: 0, experiments: 0, daysSince: 1 };
    expect(shouldPropose(p, counts, '2026-10-30T00:01:00Z')).toBe(false);
    expect(shouldPropose(p, counts, '2026-10-30T00:04:00Z')).toBe(true);
  });
});

describe('buildEvolveMessages（prompt 快照纪律）', () => {
  const previous = portrait({
    calibrations: [{ section: 'baseColor', verdict: 'miss', correction: '其实我是怕拖累别人', at: '2026-09-01T00:00:00Z' }],
  });
  const material = {
    memories: [{ date: '2026-09-10', text: '聊到发工资先还债', sessionId: 's1' }],
    journals: [{ createdAt: '2026-09-11T00:00:00Z', content: '今天试着给自己买了点东西' }],
    experiments: [{ date: '2026-09-12', action: '买花', feeling: '心虚但买了' }],
    missCorrections: [{ section: 'baseColor', correction: '其实我是怕拖累别人' }],
  };

  it('四条红线逐字继承 + 演进纪律关键句 + 语言钉死', () => {
    const { system } = buildEvolveMessages('zh-CN', previous, material);
    expect(system).toContain('- 不够素材的地方宁可少写，禁止编造（画像里没有的内容不出现）');
    expect(system).toContain('- spoken 只引用用户问卷/初谈/对话里的原话片段，不改写');
    expect(system).toContain('- script 最多一条；用「也许」「可能」，禁止断言');
    expect(system).toContain('- 不出现任何理财建议、诊断、病症词汇');
    expect(system).toContain('必须以修正后的话为准，禁止回退到修正前');
    expect(system).toContain('在上一版的基础上改写，不要另起炉灶');
    expect(system).toContain('与第一版完全一致');
    expect(system).toContain('简体中文');
  });

  it('en 语言钉死行跟随 locale', () => {
    const { system } = buildEvolveMessages('en', previous, material);
    expect(system).toContain('English');
  });

  it('素材五段齐全：上一版画像不带 questionnaire、修正记录、摘要/日记/微行动', () => {
    const { messages } = buildEvolveMessages('zh-CN', previous, material);
    const user = messages[0]?.content ?? '';
    expect(user).toContain('我一花钱就心虚');
    expect(user).not.toContain('questionnaire');
    expect(user).toContain('其实我是怕拖累别人');
    expect(user).toContain('聊到发工资先还债');
    expect(user).toContain('今天试着给自己买了点东西');
    expect(user).toContain('买花');
    expect(user).toContain('心虚但买了');
  });
});
