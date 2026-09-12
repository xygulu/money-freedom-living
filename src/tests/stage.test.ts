import { describe, expect, it } from 'vitest';
import { computeStageProgress, stageLampScales, STAGE_LAMPS, MAX_STAGE } from '@/lib/stage';
import type { GrowthProfile } from '@/lib/profile';

// M9 需求③语义修正版：灯 = 认知/行为里程碑，点亮真值是 stamps（评估确认时颁发）。
// 这里只测「灯的形状」与「stamps → done」的展示判定；评估判定本身在 assess.test.ts。

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

describe('computeStageProgress（stamps 即点亮真值）', () => {
  it('done 只看 stamps 里有没有这枚印——机械时代存量印继续有效', () => {
    const p = profile({ stamps: stamps(['stage1_story', 'stage1_color']) });
    const pr = computeStageProgress(1, p);
    expect(pr.checks.map((c) => c.done)).toEqual([true, false, true]);
    expect(pr.litCount).toBe(2);
    // 操作数据不参与判定：聊再多、实验再多，没有评估确认就不亮
    const busy = profile({
      memories: Array.from({ length: 20 }, (_, i) => ({ date: '2026-09-01', text: String(i) })),
      experiments: Array.from({ length: 10 }, () => ({ date: '2026-09-01', action: 'x' })),
    });
    expect(computeStageProgress(1, busy).litCount).toBe(0);
  });

  it('未点亮灯携带 labelKey（「这盏灯是什么」）；点亮灯携带 kind（心印见证文案）', () => {
    const p = profile({ stamps: stamps(['stage2_claim']) });
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

describe('stageLampScales（四段刻度：进度条心印刻度的真值）', () => {
  it('各段 lit/total 按该段灯集统计；混入 stage4_entered 与重复 kind 不多算', () => {
    const p = profile({
      stamps: stamps(['stage1_story', 'stage1_story', 'stage1_color', 'stage2_claim', 'stage4_entered']),
    });
    expect(stageLampScales(p)).toEqual([
      { id: 1, lit: 2, total: 3 },
      { id: 2, lit: 1, total: 3 },
      { id: 3, lit: 0, total: 2 },
      { id: 4, lit: 0, total: 0 },
    ]);
  });

  it('空 stamps 全零刻度；stage4 total 恒 0（无灯无终点线，进度条整段淡色）', () => {
    const empty = stageLampScales(profile());
    expect(empty.map((s) => s.lit)).toEqual([0, 0, 0, 0]);
    expect(empty[3]).toEqual({ id: 4, lit: 0, total: 0 });
    // 全点亮：三段满、第四段仍 0
    const all = profile({
      stage: 4,
      stamps: stamps(['stage1_story', 'stage1_script', 'stage1_color', 'stage2_claim', 'stage2_try', 'stage2_voice', 'stage3_seven', 'stage3_review']),
    });
    expect(stageLampScales(all).map((s) => [s.lit, s.total])).toEqual([[3, 3], [3, 3], [2, 2], [0, 0]]);
  });
});
