import { describe, expect, it } from 'vitest';
import { computeStageProgress, stageLampScales, stageAdvanceTarget, STAGE_LAMPS, MAX_STAGE } from '@/lib/stage';
import type { GrowthProfile } from '@/lib/profile';

// 灯 = 评估结论：点亮真值是最近一次确认评估的 lamps（assessment.confirmed），
// 不是 stamps（动作存档，不参与判定）。这里只测「灯的形状」与「评估结论 →
// done/刻度」的展示判定；评估判定本身在 assess.test.ts。

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
  assessment: {
    pending: null,
    confirmed: null,
    confirmedAt: null,
    dismissedAt: null,
    generatingAt: null,
    proposedSeenAt: null,
  },
  created_at: '2026-08-01T00:00:00Z',
  dailySeen: [],
  payday: null,
  total_active_days: 0,
  last_active_date: null,
  ...over,
});

const stamps = (kinds: string[]) => kinds.map((kind) => ({ kind, earnedAt: '2026-09-01T00:00:00Z' }));

/** 最近一次确认评估的种子：lamps 就是灯的判定真值（其余报告字段展示用，占位即可） */
const confirmedWith = (lamps: { kind: string; lit: boolean; evidence: string }[]) => ({
  ...profile().assessment,
  confirmed: {
    actualStage: 1,
    lamps,
    summary: 's',
    diagnosis: 'd',
    distance: 'f',
    actions: [],
    nextHint: '',
    assessedAt: '2026-09-01T00:00:00Z',
  },
});

describe('STAGE_LAMPS（灯判定表的形状）', () => {
  it('阶段 1/2/3 分别 3/3/2 盏灯；kind 在各阶段内唯一；hint 非空（评估 prompt 的判定提示）', () => {
    expect(STAGE_LAMPS[1].map((r) => r.kind)).toEqual(['stage1_story', 'stage1_script', 'stage1_color']);
    expect(STAGE_LAMPS[2].map((r) => r.kind)).toEqual(['stage2_claim', 'stage2_try', 'stage2_voice']);
    expect(STAGE_LAMPS[3].map((r) => r.kind)).toEqual(['stage3_seven', 'stage3_review']);
    for (const rules of Object.values(STAGE_LAMPS)) {
      const kinds = rules.map((r) => r.kind);
      expect(new Set(kinds).size).toBe(kinds.length);
      for (const r of rules) {
        expect(r.labelKey).toMatch(/^stageLamp/);
        expect(r.hint.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('阶段 4 无灯（活法没有终点线）；越界阶段同样安全返回空', () => {
    expect(STAGE_LAMPS[4]).toBeUndefined();
    expect(MAX_STAGE).toBe(4);
  });
});

describe('computeStageProgress（最近一次确认评估 = 点亮真值）', () => {
  it('done 只看评估结论：评估说亮才亮，评估没覆盖的灯一律未点亮', () => {
    const p = profile({
      assessment: confirmedWith([
        { kind: 'stage1_story', lit: true, evidence: 'e1' },
        { kind: 'stage1_script', lit: false, evidence: '' },
        { kind: 'stage1_color', lit: true, evidence: 'e2' },
      ]),
    });
    const pr = computeStageProgress(1, p);
    expect(pr.checks.map((c) => c.done)).toEqual([true, false, true]);
    expect(pr.litCount).toBe(2);
    // stamps 是动作存档，不参与判定：历史印再多也点不亮评估没说亮的灯
    const legacy = profile({
      stamps: stamps(['stage1_script', 'stage1_color']),
      assessment: confirmedWith([{ kind: 'stage1_story', lit: true, evidence: 'e1' }]),
    });
    expect(computeStageProgress(1, legacy).checks.map((c) => c.done)).toEqual([true, false, false]);
    // 无确认评估 → 全不亮；操作数据不参与判定（聊再多、实验再多也不亮）
    expect(computeStageProgress(1, profile()).litCount).toBe(0);
    const busy = profile({
      memories: Array.from({ length: 20 }, (_, i) => ({ date: '2026-09-01', text: String(i) })),
      experiments: Array.from({ length: 10 }, () => ({ date: '2026-09-01', action: 'x' })),
    });
    expect(computeStageProgress(1, busy).litCount).toBe(0);
  });

  it('每盏灯都携带 kind + labelKey（「这盏灯是什么」，点亮/未点亮共用）', () => {
    const p = profile({ assessment: confirmedWith([{ kind: 'stage2_claim', lit: true, evidence: 'e' }]) });
    const pr = computeStageProgress(2, p);
    expect(pr.checks.find((c) => c.kind === 'stage2_claim')).toMatchObject({ done: true, labelKey: 'stageLampClaim' });
    expect(pr.checks.find((c) => c.done === false)).toMatchObject({ labelKey: 'stageLampTry' });
  });

  it('阶段 4 无 checks；越界 stage（0/9）安全返回空集', () => {
    const p = profile({ stage: 4, stamps: stamps(['stage4_entered']) });
    expect(computeStageProgress(4, p)).toEqual({ checks: [], litCount: 0 });
    expect(computeStageProgress(0, p).checks).toHaveLength(0);
    expect(computeStageProgress(9, p).checks).toHaveLength(0);
  });
});

describe('stageLampScales（四段刻度 = 评估结论：走过段满、当前段按确认评估、未到段空）', () => {
  it('推进后的确认评估还是上一阶段的灯：走过的段整段填充，当前段从 0 起', () => {
    const p = profile({
      stage: 2,
      assessment: confirmedWith([
        { kind: 'stage1_story', lit: true, evidence: 'e' },
        { kind: 'stage1_script', lit: true, evidence: 'e' },
        { kind: 'stage1_color', lit: false, evidence: '' },
      ]),
    });
    expect(stageLampScales(p)).toEqual([
      { id: 1, lit: 3, total: 3 },
      { id: 2, lit: 0, total: 3 },
      { id: 3, lit: 0, total: 2 },
      { id: 4, lit: 0, total: 0 },
    ]);
  });

  it('当前段的灯被确认评估覆盖时按 lit 计数；历史 stamps 存档印不多算', () => {
    const p = profile({
      stage: 2,
      stamps: stamps(['stage1_story', 'stage2_claim', 'stage2_voice', 'stage4_entered']),
      assessment: confirmedWith([
        { kind: 'stage2_claim', lit: true, evidence: 'e' },
        { kind: 'stage2_try', lit: false, evidence: '' },
        { kind: 'stage2_voice', lit: false, evidence: '' },
      ]),
    });
    expect(stageLampScales(p)).toEqual([
      { id: 1, lit: 3, total: 3 },
      { id: 2, lit: 1, total: 3 },
      { id: 3, lit: 0, total: 2 },
      { id: 4, lit: 0, total: 0 },
    ]);
  });

  it('无确认评估全零刻度（不造假进度）；stage4 total 恒 0（无灯无终点线，整段淡色）', () => {
    const empty = stageLampScales(profile());
    expect(empty.map((s) => s.lit)).toEqual([0, 0, 0, 0]);
    expect(empty[3]).toEqual({ id: 4, lit: 0, total: 0 });
  });
});

describe('stageAdvanceTarget（程度制联动：本阶段灯全亮 → 下一阶段开启）', () => {
  const litAll = (stage: number) => STAGE_LAMPS[stage].map((r) => ({ kind: r.kind, lit: true, evidence: '程度达成的依据。' }));
  const litSome = (stage: number, n: number) =>
    STAGE_LAMPS[stage].map((r, i) => ({ kind: r.kind, lit: i < n, evidence: i < n ? '依据。' : '' }));

  it('本阶段灯全亮且已确认 → 推进到下一阶段（stage1→2、stage3→4 封顶）', () => {
    expect(stageAdvanceTarget({ ...profile(), assessment: confirmedWith(litAll(1)) })).toBe(2);
    expect(stageAdvanceTarget({ ...profile(), stage: 3, assessment: confirmedWith(litAll(3)) })).toBe(4);
  });

  it('有灯未点亮 / 无确认评估 / stage4（无灯无终点线）→ null', () => {
    expect(stageAdvanceTarget({ ...profile(), assessment: confirmedWith(litSome(1, 2)) })).toBeNull();
    expect(stageAdvanceTarget(profile())).toBeNull();
    expect(stageAdvanceTarget({ ...profile(), stage: 4 })).toBeNull();
  });

  it('只认本阶段灯集：下一阶段的灯全亮不代表本阶段完成（推进后不连环跳）', () => {
    // 站在阶段 2，确认评估是阶段 2 的评估（三盏全亮属于阶段 2）→ 才推进；
    // 阶段 1 的旧评估灯再亮也管不到阶段 2 的判定
    const stage2Assessment = { ...confirmedWith(litAll(2)), actualStage: 2 };
    expect(stageAdvanceTarget({ ...profile(), stage: 2, assessment: stage2Assessment })).toBe(3);
    const stage1OldAssessment = { ...confirmedWith(litAll(1)), actualStage: 1 };
    expect(stageAdvanceTarget({ ...profile(), stage: 2, assessment: stage1OldAssessment })).toBeNull();
  });
});
