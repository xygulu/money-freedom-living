// 机制仪表纯函数（2026-09-24 批 1c）：把漏斗聚合的口径钉死。
// DB 聚合部分走 smoke/线上验，这里只测纯函数——ratioOf 的 0/0 语义、
// 六节点分桶的"没答过的节点保留全 0 行"、触达 per-node 合并。
import { describe, expect, it } from 'vitest';
import { aggregateNodeVerdicts, mergeTouchCounts, ratioOf } from '@/lib/metrics';
import type { NodeVerdictRow } from '@/lib/verdicts';

function verdictRow(partial: Partial<NodeVerdictRow>): NodeVerdictRow {
  return {
    userKey: 'u:x',
    node: 'D7',
    verdict: 'pending',
    behaviorOk: false,
    cognitionOk: false,
    basisTopic: null,
    basisAt: null,
    source: 'app',
    at: '2026-09-24T00:00:00.000Z',
    ...partial,
  };
}

describe('ratioOf —— 0/0 不是 0%', () => {
  it('分母 0 → null（"没人"和"全都没做到"是两回事）', () => {
    expect(ratioOf(0, 0)).toBeNull();
    expect(ratioOf(3, 0)).toBeNull();
  });

  it('正常比值', () => {
    expect(ratioOf(1, 4)).toBe(0.25);
    expect(ratioOf(0, 5)).toBe(0);
  });

  it('NaN / 负数 / Infinity 一律 null', () => {
    expect(ratioOf(Number.NaN, 1)).toBeNull();
    expect(ratioOf(1, Number.NaN)).toBeNull();
    expect(ratioOf(-1, 5)).toBeNull();
    expect(ratioOf(1, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('aggregateNodeVerdicts —— 六节点三态分桶', () => {
  it('没人答的节点保留全 0 行（缺行会读成"都答了"）', () => {
    const buckets = aggregateNodeVerdicts([]);
    expect(buckets).toHaveLength(6);
    expect(buckets.map((b) => b.node)).toEqual(['D7', 'D14', 'D21', 'D30', 'D66', 'D90']);
    expect(buckets.every((b) => b.total === 0)).toBe(true);
  });

  it('三态计数 + fromTouch 单列（归因链修好后这里才有非零值）', () => {
    const buckets = aggregateNodeVerdicts([
      verdictRow({ node: 'D7', verdict: 'yes', source: 'touch' }),
      verdictRow({ node: 'D7', verdict: 'yes', source: 'app' }),
      verdictRow({ node: 'D14', verdict: 'no', source: 'app' }),
      verdictRow({ node: 'D14', verdict: 'pending', source: 'touch' }),
    ]);
    const d7 = buckets.find((b) => b.node === 'D7')!;
    const d14 = buckets.find((b) => b.node === 'D14')!;
    expect(d7).toMatchObject({ yes: 2, no: 0, pending: 0, fromTouch: 1, total: 2 });
    expect(d14).toMatchObject({ yes: 0, no: 1, pending: 1, fromTouch: 1, total: 2 });
  });

  it('认不出的节点丢弃（兜底；listNodeVerdicts 已滤）', () => {
    const buckets = aggregateNodeVerdicts([verdictRow({ node: 'D100' as never })]);
    expect(buckets.every((b) => b.total === 0)).toBe(true);
  });
});

describe('mergeTouchCounts —— 触达 per-node 合并', () => {
  it('sent / return 并表并按节点序排（D3 < D7 < D30…）', () => {
    const merged = mergeTouchCounts(
      [{ node: 'D30', n: 2 }, { node: 'D3', n: 5 }, { node: 'D7', n: 3 }],
      [{ node: 'D7', n: 1 }, { node: 'D3', n: 2 }],
    );
    expect(merged.map((m) => m.node)).toEqual(['D3', 'D7', 'D30']);
    expect(merged.find((m) => m.node === 'D3')).toEqual({ node: 'D3', sent: 5, returned: 2 });
    expect(merged.find((m) => m.node === 'D7')).toEqual({ node: 'D7', sent: 3, returned: 1 });
    expect(merged.find((m) => m.node === 'D30')).toEqual({ node: 'D30', sent: 2, returned: 0 });
  });

  it('只有回程没有发出的节点也保留（数据异常时可见）', () => {
    const merged = mergeTouchCounts([], [{ node: 'D7', n: 1 }]);
    expect(merged).toEqual([{ node: 'D7', sent: 0, returned: 1 }]);
  });
});
