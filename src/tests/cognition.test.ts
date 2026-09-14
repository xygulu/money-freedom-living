// 认知层三指标（docs/10 §1）：L5 停顿、L4 迁移、M 恢复时间 + 6 节点三态。
//
// 这些用例守的不是"算得对"，而是几条产品红线：
// - ③可留空、可点"想不起来"——留空和点了"想不起来"都不该被当成停顿（L5 会因此虚高）
// - 恢复天数由读取端算，不落库：改一次口径不用迁移历史数据
// - 行为达标记 done 才算，partial 不算；"没做完"被当成没做，这一格才有意义
// - 认知不达标不直接判 no——no 会触发提前收官，而收官是对整轮验证下结论
import { describe, expect, it } from 'vitest';
import {
  DID_VALUES,
  isDidToday,
  isPause,
  isVerdictNode,
  nodeVerdict,
  priorLines,
  recoveryDays,
  topicForToday,
  VERDICT_NODES,
} from '@/lib/cognition';
import type { GrowthProfile, ThreadEvidence } from '@/lib/profile';

function ev(at: string, kind?: ThreadEvidence['kind'], quote = '我不配'): ThreadEvidence {
  return { at, bookId: 'v1', source: 'close', quote, kind };
}

function prof(threads: GrowthProfile['threads']): Pick<GrowthProfile, 'threads'> {
  return { threads };
}

describe('一格提交的取值', () => {
  it('只认三个值', () => {
    expect(DID_VALUES).toEqual(['done', 'partial', 'missed']);
    expect(isDidToday('done')).toBe(true);
    expect(isDidToday('partial')).toBe(true);
    expect(isDidToday('missed')).toBe(true);
  });

  it('别的都不认（前端传了脏值不会被当成"做了"）', () => {
    for (const v of ['', 'yes', 'DONE', true, 1, null, undefined, {}]) {
      expect(isDidToday(v)).toBe(false);
    }
  });
});

describe('L5 停顿：③填了才算', () => {
  it('写了字就是停顿', () => {
    expect(isPause('我配得上', false)).toBe(true);
  });

  it('留空不算——可跳过是硬要求，留空不是失败', () => {
    expect(isPause('', false)).toBe(false);
    expect(isPause('   ', false)).toBe(false);
  });

  it('点了「想不起来」不算：那是照实回答，不是停顿', () => {
    expect(isPause('我不配', true)).toBe(false);
  });
});

describe('今天的线：AI 给的优先，其次当前阶段的灯，再其次碰过的', () => {
  it('AI 给了就用 AI 的', () => {
    const p = { stage: 1, threads: { parents: { evidence: [ev('2026-09-01T00:00:00Z')] } } } as unknown as GrowthProfile;
    expect(topicForToday(p, 'v1', 'money-safety')).toBe('money-safety');
  });

  it('AI 没给就按当前阶段的第一盏灯', () => {
    const p = { stage: 1, threads: {} } as unknown as GrowthProfile;
    const t = topicForToday(p, 'v1');
    expect(t).toBeTruthy();
  });

  it('什么都没有也兜得住（不会返回 undefined 写进库）', () => {
    const p = { stage: 1, threads: {} } as unknown as GrowthProfile;
    expect(typeof topicForToday(p, 'v1', undefined)).toBe('string');
  });
});

describe('priorLines：只取记过 kind 的，按时间取最后几条', () => {
  it('没记 kind 的证据不进对照池（普通证据不是"他说过的那句话"）', () => {
    const p = prof({
      'self-worth': {
        evidence: [ev('2026-09-01T00:00:00Z'), ev('2026-09-02T00:00:00Z', 'pause', '我不配')],
      },
    } as unknown as GrowthProfile['threads']);
    const lines = priorLines(p);
    expect(lines).toHaveLength(1);
    expect(lines[0].quote).toBe('我不配');
  });

  it('跨线合并、按时间升序（给模型看的是"他先后说过什么"）', () => {
    const p = prof({
      'self-worth': { evidence: [ev('2026-09-03T00:00:00Z', 'regress', '我不配')] },
      parents: { evidence: [ev('2026-09-01T00:00:00Z', 'pause', '都是我的错')] },
    } as unknown as GrowthProfile['threads']);
    const lines = priorLines(p);
    expect(lines.map((l) => l.at)).toEqual(['2026-09-01T00:00:00Z', '2026-09-03T00:00:00Z']);
  });

  it('限 8 条且取最近的（预算：这是要进 prompt 的）', () => {
    const evidence = Array.from({ length: 20 }, (_, i) =>
      ev(`2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`, 'pause', `第${i + 1}句`)
    );
    const p = prof({ 'self-worth': { evidence } } as unknown as GrowthProfile['threads']);
    const lines = priorLines(p);
    expect(lines).toHaveLength(8);
    expect(lines.at(-1)?.quote).toBe('第20句');
  });
});

describe('M 恢复时间：读取端算，不落库', () => {
  it('掉一次又走出来 → 一个天数', () => {
    const p = prof({
      'self-worth': {
        evidence: [
          ev('2026-09-01T00:00:00Z', 'regress'),
          ev('2026-09-05T00:00:00Z', 'migrate', '我值得'),
        ],
      },
    } as unknown as GrowthProfile['threads']);
    expect(recoveryDays(p)).toEqual([4]);
  });

  it('连着掉几次只算第一次（否则同一段难走的时期会被重复计数）', () => {
    const p = prof({
      'self-worth': {
        evidence: [
          ev('2026-09-01T00:00:00Z', 'regress'),
          ev('2026-09-02T00:00:00Z', 'regress'),
          ev('2026-09-03T00:00:00Z', 'regress'),
          ev('2026-09-06T00:00:00Z', 'migrate', '我值得'),
        ],
      },
    } as unknown as GrowthProfile['threads']);
    expect(recoveryDays(p)).toEqual([5]);
  });

  it('掉了还没走出来 → 不产生数字（不是 0 天，是没有这一段）', () => {
    const p = prof({
      'self-worth': { evidence: [ev('2026-09-01T00:00:00Z', 'regress')] },
    } as unknown as GrowthProfile['threads']);
    expect(recoveryDays(p)).toEqual([]);
  });

  it('走出来在前、掉在后 → 那一对不算', () => {
    const p = prof({
      'self-worth': {
        evidence: [
          ev('2026-09-01T00:00:00Z', 'migrate', '我值得'),
          ev('2026-09-05T00:00:00Z', 'regress'),
        ],
      },
    } as unknown as GrowthProfile['threads']);
    expect(recoveryDays(p)).toEqual([]);
  });

  it('没有任何证据 → 空数组，不抛错', () => {
    expect(recoveryDays({} as unknown as GrowthProfile['threads'] as never)).toEqual([]);
  });
});

describe('6 节点三态', () => {
  it('节点名单就是那六个', () => {
    expect(VERDICT_NODES).toEqual(['D7', 'D14', 'D21', 'D30', 'D66', 'D90']);
    expect(isVerdictNode('D7')).toBe(true);
    expect(isVerdictNode('D8')).toBe(false);
    expect(isVerdictNode('d7')).toBe(false);
  });

  it('做了 + 有停顿 → 成立', () => {
    expect(nodeVerdict({ did: 'done', pause: true })).toEqual({
      verdict: 'yes',
      behaviorOk: true,
      cognitionOk: true,
    });
  });

  it('没做 + 没停顿 → 不成立', () => {
    expect(nodeVerdict({ did: 'missed', pause: false }).verdict).toBe('no');
  });

  it('「没做完」算行为不达标——partial 就是没做完，别给自己留后门', () => {
    expect(nodeVerdict({ did: 'partial', pause: true })).toEqual({
      verdict: 'pending',
      behaviorOk: false,
      cognitionOk: true,
    });
  });

  it('行为达标、认知不达标 → 待续，不直接判 no', () => {
    // 这是判定表里的"机制空转"：动作在跑，话没变。它不判 no，因为 no 会触发提前收官，
    // 而收官是对整轮验证下结论——空转只是"再看一段"。
    expect(nodeVerdict({ did: 'done', pause: false })).toEqual({
      verdict: 'pending',
      behaviorOk: true,
      cognitionOk: false,
    });
  });
});
