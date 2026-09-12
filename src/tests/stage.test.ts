import { describe, expect, it } from 'vitest';
import { computeStageProgress, pendingStamps, MAX_STAGE } from '@/lib/stage';
import type { GrowthProfile, Portrait } from '@/lib/profile';

const portrait = (over: Partial<Portrait> = {}): Portrait => ({
  spoken: [],
  baseColor: '你总觉得自己不配',
  moments: [],
  script: '你可能觉得钱是要还的债',
  toFuture: '',
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
  created_at: '2026-08-01T00:00:00Z',
  dailySeen: [],
  payday: null,
  total_active_days: 0,
  last_active_date: null,
  ...over,
});

describe('computeStageProgress（判定矩阵）', () => {
  it('阶段 1：三盏灯分别对应 画像存在 / script 校准 / baseColor 校准', () => {
    const p = profile({ portrait: portrait({ calibrations: [{ section: 'script', verdict: 'hit', at: '2026-09-01T00:00:00Z' }] }) });
    const done = computeStageProgress(1, p).checks.filter((c) => c.done).map((c) => c.kind);
    expect(done).toEqual(['stage1_story', 'stage1_script']);
    // hit/miss 都算表态（miss 带 correction 也是「回应过了」），命中判定
    const missed = profile({ portrait: portrait({ calibrations: [{ section: 'script', verdict: 'miss', correction: '不是这样', at: '2026-09-01T00:00:00Z' }] }) });
    expect(computeStageProgress(1, missed).checks.find((c) => c.kind === 'stage1_script')?.done).toBe(true);
    // moments/toFuture 校准不算
    const noise = profile({ portrait: portrait({ calibrations: [{ section: 'moment:0', verdict: 'hit', at: '2026-09-01T00:00:00Z' }] }) });
    expect(computeStageProgress(1, noise).litCount).toBe(1); // 只有画像存在
  });

  it('阶段 2：confirmed 脚本 / experiments≥1 / memories≥3（近似信号）', () => {
    const p = profile({ stage: 2, portrait: portrait({ scriptStatus: 'confirmed' }), experiments: [{ date: '2026-09-01', action: 'a' }], memories: [{ date: '2026-09-01', text: '1' }, { date: '2026-09-02', text: '2' }] });
    const pr = computeStageProgress(2, p);
    expect(pr.checks.map((c) => c.done)).toEqual([true, true, false]);
    expect(pr.canAdvance).toBe(false);
    p.memories.push({ date: '2026-09-03', text: '3' });
    expect(computeStageProgress(2, p).canAdvance).toBe(true);
  });

  it('阶段 3：experiments≥7 / 画像 version≥2', () => {
    const six = profile({ stage: 3, portrait: portrait({ version: 2 }), experiments: Array.from({ length: 6 }, (_, i) => ({ date: '2026-09-01', action: String(i) })) });
    expect(computeStageProgress(3, six).canAdvance).toBe(false);
    six.experiments.push({ date: '2026-09-02', action: '7' });
    expect(computeStageProgress(3, six).canAdvance).toBe(true);
  });

  it('阶段 4 无 checks、永不 canAdvance；越界输入同样安全', () => {
    const p = profile({ stage: 4, experiments: Array.from({ length: 99 }, () => ({ date: '2026-09-01', action: 'x' })) });
    const pr = computeStageProgress(4, p);
    expect(pr.checks).toHaveLength(0);
    expect(pr.canAdvance).toBe(false);
    expect(computeStageProgress(0, p).canAdvance).toBe(false);
    expect(computeStageProgress(9, p).canAdvance).toBe(false);
    expect(MAX_STAGE).toBe(4);
  });
});

describe('pendingStamps（已达标未颁发的差集）', () => {
  it('达标而未颁发 → 颁发清单；已颁发不再出现（幂等）', () => {
    const p = profile({ portrait: portrait({ calibrations: [{ section: 'script', verdict: 'hit', at: '2026-09-01T00:00:00Z' }, { section: 'baseColor', verdict: 'hit', at: '2026-09-01T00:00:00Z' }] }) });
    expect(pendingStamps(p)).toEqual(['stage1_story', 'stage1_script', 'stage1_color']);
    p.stamps = [
      { kind: 'stage1_story', earnedAt: '2026-09-01T00:00:00Z' },
      { kind: 'stage1_script', earnedAt: '2026-09-01T00:00:00Z' },
      { kind: 'stage1_color', earnedAt: '2026-09-01T00:00:00Z' },
    ];
    expect(pendingStamps(p)).toEqual([]);
  });

  it('推进瞬间的旧阶段灯不丢：stage=2 仍会补发阶段 1 未颁发的印', () => {
    const p = profile({
      stage: 2,
      portrait: portrait({ calibrations: [{ section: 'baseColor', verdict: 'miss', correction: 'x', at: '2026-09-01T00:00:00Z' }] }),
      stamps: [{ kind: 'stage2_entered', earnedAt: '2026-09-02T00:00:00Z' }],
    });
    // 阶段 1 的 story/color 两盏灯当时已达成但没来得及颁发
    expect(pendingStamps(p)).toEqual(['stage1_story', 'stage1_color']);
  });

  it('阶段 4 本身不设灯；此前阶段的心印若已颁齐则差集为空（只保留收藏）', () => {
    const p = profile({
      stage: 4,
      portrait: portrait({ version: 2, calibrations: [{ section: 'script', verdict: 'hit', at: '2026-09-01T00:00:00Z' }, { section: 'baseColor', verdict: 'hit', at: '2026-09-01T00:00:00Z' }], scriptStatus: 'confirmed' }),
      experiments: Array.from({ length: 10 }, () => ({ date: '2026-09-01', action: 'x' })),
      memories: Array.from({ length: 4 }, (_, i) => ({ date: '2026-09-01', text: String(i) })),
      stamps: [
        'stage1_story', 'stage1_script', 'stage1_color',
        'stage2_entered', 'stage2_claim', 'stage2_try', 'stage2_voice',
        'stage3_entered', 'stage3_seven', 'stage3_review',
        'stage4_entered',
      ].map((kind) => ({ kind, earnedAt: '2026-09-01T00:00:00Z' })),
    });
    expect(pendingStamps(p)).toEqual([]);
  });
});
