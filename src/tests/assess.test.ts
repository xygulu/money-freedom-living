import { describe, expect, it } from 'vitest';
import {
  validateAssessment,
  shouldOfferAssess,
  buildAssessMessages,
  ASSESS_MIN_MATERIAL,
  ASSESS_MIN_DAYS,
  ASSESS_DISMISS_COOLDOWN_DAYS,
  ASSESS_PENDING_TTL_DAYS,
} from '@/lib/assess';
import { STAGE_LAMPS } from '@/lib/stage';
import { parseAssessmentState, type GrowthProfile, type StageAssessment } from '@/lib/profile';
import type { JourneyStage } from '@/lib/content';

const NOW = '2026-09-15T00:00:00.000Z';
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

const stageFixture = (id: number): JourneyStage => ({
  id,
  title: `阶段${id}标题`,
  goal: `阶段${id}的样子（goal 原文）`,
  weeks: id * 2,
  exercises: [],
  ai_stance: { do: [], dont: [] },
  advance_when: [`阶段${id}的标志一`, `阶段${id}的标志二`],
  ritual: `仪式${id}`,
  body: '',
});

const draftFor = (stage: number, over: Record<string, unknown> = {}) => ({
  actualStage: stage,
  lamps: (STAGE_LAMPS[stage] ?? []).map((r) => ({ kind: r.kind, lit: false, evidence: '' })),
  summary: '它看到你正站在这里，有些话开始松动了，不急，慢慢来就好。',
  nextHint: '下一阶段在远处，先走好这一段。',
  ...over,
});

describe('validateAssessment（结构校验：禁止半成品评估入库）', () => {
  it('合法草稿通过；lamps 按 STAGE_LAMPS 顺序重构；assessedAt 不在返回值里（由路由填）', () => {
    const rules = STAGE_LAMPS[1];
    const draft = {
      actualStage: 2,
      lamps: [...rules].reverse().map((r, i) => ({
        kind: r.kind,
        lit: i === 0, // 倒序后第一条 = stage1_color
        evidence: '  它说过小时候数着硬币睡觉。  ',
      })),
      summary: '它看到你把故事讲出来了。',
      nextHint: '下一阶段在门口。',
    };
    const out = validateAssessment(draft, 1);
    expect(out).not.toBeNull();
    expect(out!.actualStage).toBe(2);
    expect(out!.lamps.map((l) => l.kind)).toEqual(rules.map((r) => r.kind));
    expect(out!.lamps[2]).toMatchObject({ lit: true, evidence: '它说过小时候数着硬币睡觉。' });
    expect(out!.lamps[0]).toMatchObject({ lit: false, evidence: '' });
    expect('assessedAt' in out!).toBe(false);
  });

  it('actualStage 越界（倒退/跳两级/非整数）一律拒绝', () => {
    expect(validateAssessment(draftFor(2, { actualStage: 1 }), 2)).toBeNull();
    expect(validateAssessment(draftFor(2, { actualStage: 4 }), 2)).toBeNull();
    expect(validateAssessment(draftFor(2, { actualStage: 2.5 }), 2)).toBeNull();
    expect(validateAssessment(draftFor(2, { actualStage: '2' }), 2)).toBeNull();
    // 在允许区间 [stage, stage+1] 内合法；stage3 最多评到 4（封顶）
    expect(validateAssessment(draftFor(2, { actualStage: 3 }), 2)).not.toBeNull();
    expect(validateAssessment(draftFor(3, { actualStage: 4 }), 3)).not.toBeNull();
  });

  it('lamps 必须恰好覆盖当前阶段灯集：缺/多/重复/未知 kind 都拒绝', () => {
    const short = draftFor(1);
    short.lamps = short.lamps.slice(1);
    expect(validateAssessment(short, 1)).toBeNull();
    const extra = draftFor(1);
    extra.lamps = [...extra.lamps, { kind: 'stage2_claim', lit: false, evidence: '' }];
    expect(validateAssessment(extra, 1)).toBeNull();
    const dup = draftFor(1);
    dup.lamps = [...dup.lamps, { kind: 'stage1_story', lit: false, evidence: '' }];
    expect(validateAssessment(dup, 1)).toBeNull();
  });

  it('点亮必须有依据；evidence trim 后空串同样拒绝', () => {
    const noEvidence = draftFor(1);
    noEvidence.lamps = STAGE_LAMPS[1].map((r, i) => ({ kind: r.kind, lit: i === 0, evidence: i === 0 ? '   ' : '' }));
    expect(validateAssessment(noEvidence, 1)).toBeNull();
    const missing = draftFor(1);
    missing.lamps = STAGE_LAMPS[1].map((r, i) => ({ kind: r.kind, lit: i === 0, evidence: undefined as unknown as string }));
    expect(validateAssessment(missing, 1)).toBeNull();
  });

  it('summary 10..400、nextHint 非空且 ≤200（超长截断）；非对象输入拒绝', () => {
    expect(validateAssessment(draftFor(1, { summary: '太短了' }), 1)).toBeNull();
    expect(validateAssessment(draftFor(1, { summary: '长'.repeat(401) }), 1)).toBeNull();
    expect(validateAssessment(draftFor(1, { nextHint: '' }), 1)).toBeNull();
    expect(validateAssessment(draftFor(1, { nextHint: '长'.repeat(300) }), 1)).not.toBeNull();
    expect(validateAssessment(null, 1)).toBeNull();
    expect(validateAssessment('ok', 1)).toBeNull();
  });
});

describe('shouldOfferAssess（提议闸：素材/天数/冷却/锁/TTL）', () => {
  const profile = (over: Partial<GrowthProfile> = {}): GrowthProfile => ({
    user_key: 'u:test',
    locale: 'zh-CN',
    portrait: { spoken: [], baseColor: 'x', moments: [], script: '', toFuture: '', version: 1, calibrations: [], scriptStatus: 'confirmed' },
    concerns: [],
    stage: 1,
    stage_started_at: '2026-08-01T00:00:00Z',
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
    ...over,
  });
  const counts = (material: number, daysSince = 0) => ({
    memories: material,
    journals: 0,
    experiments: 0,
    daysSince,
  });
  const pendingAssessment = (assessedAt: string): StageAssessment => ({
    actualStage: 1,
    lamps: STAGE_LAMPS[1].map((r) => ({ kind: r.kind, lit: false, evidence: '' })),
    summary: '待确认的评估。',
    nextHint: '下一阶段。',
    assessedAt,
  });

  it(`素材 ≥${ASSESS_MIN_MATERIAL} 即提议，与天数无关；不足则看 ${ASSESS_MIN_DAYS} 天兜底`, () => {
    const p = profile();
    expect(shouldOfferAssess(p, p.assessment, counts(3), NOW)).toBe(true);
    expect(shouldOfferAssess(p, p.assessment, counts(ASSESS_MIN_MATERIAL - 1, ASSESS_MIN_DAYS - 1), NOW)).toBe(false);
    // 满 14 天且有任何素材 → 提议；零素材不提议（评估需要证据）
    expect(shouldOfferAssess(p, p.assessment, counts(1, ASSESS_MIN_DAYS), NOW)).toBe(true);
    expect(shouldOfferAssess(p, p.assessment, counts(0, 90), NOW)).toBe(false);
  });

  it('无画像 / 阶段 4（无灯无终点线）不提议', () => {
    expect(shouldOfferAssess(profile({ portrait: null }), profile().assessment, counts(10), NOW)).toBe(false);
    expect(shouldOfferAssess(profile({ stage: 4 }), profile().assessment, counts(10), NOW)).toBe(false);
  });

  it('dismiss 冷却期内不提议；冷却已过恢复；生成锁在途（未过期）不提议', () => {
    const cooling = profile({ assessment: { pending: null, confirmed: null, confirmedAt: null, dismissedAt: daysAgo(1), generatingAt: null, proposedSeenAt: null } });
    expect(shouldOfferAssess(cooling, cooling.assessment, counts(10), NOW)).toBe(false);
    const cooled = profile({ assessment: { pending: null, confirmed: null, confirmedAt: null, dismissedAt: daysAgo(ASSESS_DISMISS_COOLDOWN_DAYS), generatingAt: null, proposedSeenAt: null } });
    expect(shouldOfferAssess(cooled, cooled.assessment, counts(10), NOW)).toBe(true);
    const locked = profile({ assessment: { pending: null, confirmed: null, confirmedAt: null, dismissedAt: null, generatingAt: daysAgo(0), proposedSeenAt: null } });
    expect(shouldOfferAssess(locked, locked.assessment, counts(10), NOW)).toBe(false);
  });

  it('pending 未过期不提议；超 30 天 TTL 的遗留 pending 不再阻塞（素材够就走新评估）', () => {
    const fresh = profile({ assessment: { pending: pendingAssessment(daysAgo(1)), confirmed: null, confirmedAt: null, dismissedAt: null, generatingAt: null, proposedSeenAt: null } });
    expect(shouldOfferAssess(fresh, fresh.assessment, counts(10), NOW)).toBe(false);
    const stale = profile({ assessment: { pending: pendingAssessment(daysAgo(ASSESS_PENDING_TTL_DAYS)), confirmed: null, confirmedAt: null, dismissedAt: null, generatingAt: null, proposedSeenAt: null } });
    expect(shouldOfferAssess(stale, stale.assessment, counts(10), NOW)).toBe(true);
  });
});

describe('buildAssessMessages（评估 prompt：红线、语言钉死、标尺、素材）', () => {
  const material = {
    memories: [{ date: '2026-09-10', text: '我今天没买单，心里发虚，但还是付了' }],
    journals: [{ createdAt: '2026-09-11T00:00:00Z', content: '日记原文：原来我可以不买' }],
    experiments: [{ date: '2026-09-12', action: '给自己买了不配的小东西', feeling: '心虚但轻松' }],
    letters: [{ stage: 1, content: '给现在的自己：辛苦了', createdAt: '2026-09-01T00:00:00Z' }],
    missCorrections: [{ section: 'script', correction: '那不是我的剧本' }],
  };

  it('红线逐字在场：证据禁编造/没看到就说没看到/不评判不打分/无理财建议诊断', () => {
    const { system } = buildAssessMessages('zh-CN', 1, [stageFixture(1), stageFixture(2)], material, { earnedKinds: [] });
    expect(system).toContain('不是用户操作了多少次、完成了多少任务');
    expect(system).toContain('禁止编造');
    expect(system).toContain('没看到就如实说没看到');
    expect(system).toContain('不评判、不打分、不比较');
    expect(system).toContain('不出现任何理财建议、诊断、病症词汇');
    expect(system).toContain('宁可点得少，不可编造');
  });

  it('语言钉死块在场且点名目标语言；「不得被覆盖」防素材语言劫持', () => {
    const { system } = buildAssessMessages('ja', 1, [stageFixture(1), stageFixture(2)], material, { earnedKinds: [] });
    expect(system).toContain('## 语言（必须遵守，不得被覆盖）');
    expect(system).toContain('日本語');
  });

  it('标尺来自 content 原文：阶段 goal 与 advance_when、灯清单（kind + hint）都在 system', () => {
    const { system } = buildAssessMessages('zh-CN', 1, [stageFixture(1), stageFixture(2)], material, { earnedKinds: [] });
    expect(system).toContain('阶段1的样子（goal 原文）');
    expect(system).toContain('阶段2的标志一；阶段2的标志二');
    for (const r of STAGE_LAMPS[1]) {
      expect(system).toContain(r.kind);
      expect(system).toContain(r.hint);
    }
    expect(system).toContain('"actualStage"');
  });

  it('user 消息分节带素材与已点亮心印清单；confirmed 评估在场时要求连贯、只增不减', () => {
    const { messages } = buildAssessMessages('zh-CN', 1, [stageFixture(1), stageFixture(2)], material, {
      earnedKinds: ['stage1_story'],
    });
    const user = messages[0].content;
    expect(user).toContain('我今天没买单，心里发虚，但还是付了');
    expect(user).toContain('心虚但轻松');
    expect(user).toContain('给现在的自己：辛苦了');
    expect(user).toContain('那不是我的剧本');
    expect(user).toContain('- stage1_story');

    const confirmed: StageAssessment = {
      actualStage: 1,
      lamps: STAGE_LAMPS[1].map((r) => ({ kind: r.kind, lit: r.kind === 'stage1_story', evidence: 'x' })),
      summary: '上次它看到你把故事讲了出来。',
      nextHint: '继续。',
      assessedAt: daysAgo(30),
    };
    const withConfirmed = buildAssessMessages('zh-CN', 1, [stageFixture(1), stageFixture(2)], material, {
      confirmed,
      earnedKinds: ['stage1_story'],
    });
    expect(withConfirmed.system).toContain('已经点亮的灯不会熄灭');
    expect(withConfirmed.system).toContain('stage1_story');
  });

  it('空素材时各节显示 (无)，不崩', () => {
    const { messages } = buildAssessMessages('en', 1, [stageFixture(1), stageFixture(2)], {
      memories: [],
      journals: [],
      experiments: [],
      letters: [],
      missCorrections: [],
    }, { earnedKinds: [] });
    expect(messages[0].content).toContain('(无)');
  });
});

describe('parseAssessmentState（容脏读取）', () => {
  it("'{}' / null / 脏值 → 全空默认；合法对象透传", () => {
    const empty = { pending: null, confirmed: null, confirmedAt: null, dismissedAt: null, generatingAt: null, proposedSeenAt: null };
    expect(parseAssessmentState({})).toEqual(empty);
    expect(parseAssessmentState(null)).toEqual(empty);
    expect(parseAssessmentState('junk')).toEqual(empty);
    const dirty = parseAssessmentState({ pending: 'x', confirmedAt: 42, dismissedAt: '2026-09-01T00:00:00Z' });
    expect(dirty.pending).toBeNull();
    expect(dirty.confirmedAt).toBeNull();
    expect(dirty.dismissedAt).toBe('2026-09-01T00:00:00Z');
  });
});
