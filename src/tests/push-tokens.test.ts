import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parsePushTokens, mergePushToken, PUSH_TOKEN_CAP } from '../lib/profile';
import type { PushTokenEntry } from '../lib/profile';

// token 列表的纯函数部分（parsePushTokens/mergePushToken）：坏数据不炸、上限挤最旧。
// 路由与调度器读-合-写都走这两个纯函数——行为钉在这里，竞态自愈逻辑见 profile.ts 注释。

const entry = (token: string, at = '2026-01-01T00:00:00.000Z'): PushTokenEntry => ({
  token,
  platform: 'ios',
  addedAt: at,
  lastSeenAt: at,
});

describe('parsePushTokens：老档案/坏数据一律按空数组，坏行剔除不炸', () => {
  it('非数组 → 空数组', () => {
    expect(parsePushTokens(undefined)).toEqual([]);
    expect(parsePushTokens(null)).toEqual([]);
    expect(parsePushTokens({})).toEqual([]);
    expect(parsePushTokens('[]')).toEqual([]);
  });

  it('token 缺失/空串/platform 非 ios 的行剔除；字符串时间戳原样透传（宁可留白不编造）', () => {
    expect(
      parsePushTokens([
        { token: 'a', platform: 'ios', addedAt: 'x', lastSeenAt: 'y' },
        { platform: 'ios', addedAt: 'x', lastSeenAt: 'y' },
        { token: '', platform: 'ios', addedAt: 'x', lastSeenAt: 'y' },
        { token: 'b', platform: 'android', addedAt: 'x', lastSeenAt: 'y' },
        'garbage',
        null,
      ]),
    ).toEqual([{ token: 'a', platform: 'ios', addedAt: 'x', lastSeenAt: 'y' }]);
  });
});

describe('mergePushToken：同 token 刷新置尾，超限挤最旧', () => {
  it('新 token 追加到队尾', () => {
    const next = mergePushToken([entry('a')], 'b', 'ios', '2026-09-25T00:00:00.000Z');
    expect(next.map((t) => t.token)).toEqual(['a', 'b']);
  });

  it('同 token 上报：不重复，刷新时间并移到队尾（队尾 = 最新）', () => {
    const list = [entry('a'), entry('b')];
    const next = mergePushToken(list, 'a', 'ios', '2026-09-25T00:00:00.000Z');
    expect(next.map((t) => t.token)).toEqual(['b', 'a']);
    expect(next[1].lastSeenAt).toBe('2026-09-25T00:00:00.000Z');
    expect(next[1].addedAt).toBe('2026-09-25T00:00:00.000Z'); // 重新入库 = 新增
  });

  it(`超过 ${PUSH_TOKEN_CAP} 台挤掉最旧（数组头）；原列表不被就地修改`, () => {
    const list = Array.from({ length: PUSH_TOKEN_CAP }, (_, i) => entry(`t${i}`));
    const next = mergePushToken(list, 'fresh', 'ios', '2026-09-25T00:00:00.000Z');
    expect(next.length).toBe(PUSH_TOKEN_CAP);
    expect(next[0].token).toBe('t1'); // t0 被挤掉
    expect(next[PUSH_TOKEN_CAP - 1].token).toBe('fresh');
    expect(list[0].token).toBe('t0'); // 原列表不动
  });
});
