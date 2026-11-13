// C6（2026-11-13）：memories 存储侧滚动合并的纯函数口径。
// 注入侧只取最近 5 条（prompt.ts），存储侧超量收拢最旧的——内容收拢不删除。
import { describe, expect, it } from 'vitest';
import {
  MEMORIES_KEEP_RECENT,
  MEMORIES_MERGED_MAX_CHARS,
  MEMORIES_STORAGE_CAP,
  mergeMemoriesRolling,
  type SessionMemory,
} from '@/lib/profile';

const mem = (i: number, date = `2026-01-${String((i % 28) + 1).padStart(2, '0')}`): SessionMemory => ({
  date,
  text: `第 ${i} 场对话的摘要：他说了些关于钱的话（${i}）`,
  sessionId: `s-${i}`,
});

describe('mergeMemoriesRolling（C6）', () => {
  it('未超量 → 原样返回，不合并', () => {
    const list = Array.from({ length: MEMORIES_STORAGE_CAP }, (_, i) => mem(i + 1));
    const out = mergeMemoriesRolling(list);
    expect(out.merged).toBe(false);
    expect(out.memories).toBe(list);
  });

  it('超量 → 最旧的收拢成一条合集，保留最近 KEEP_RECENT 条原样', () => {
    const list = Array.from({ length: MEMORIES_STORAGE_CAP + 5 }, (_, i) => mem(i + 1));
    const out = mergeMemoriesRolling(list);
    expect(out.merged).toBe(true);
    expect(out.memories.length).toBe(MEMORIES_KEEP_RECENT + 1);
    // 合集在最前，代表"那段时间"
    expect(out.memories[0].text).toContain('第 1 场');
    expect(out.memories[0].text).toContain(`第 ${list.length - MEMORIES_KEEP_RECENT} 场`);
    // 最近的原样保留（sessionId 不丢——时间线可点）
    const last = out.memories[out.memories.length - 1];
    expect(last.text).toBe(list[list.length - 1].text);
    expect(last.sessionId).toBe(list[list.length - 1].sessionId);
  });

  it('合集条目：date 取最旧一条，sessionId 清空（不属于任何一场）', () => {
    const list = Array.from({ length: MEMORIES_STORAGE_CAP + 1 }, (_, i) => mem(i + 1, '2026-03-05'));
    const out = mergeMemoriesRolling(list);
    expect(out.memories[0].date).toBe('2026-03-05');
    expect(out.memories[0].sessionId).toBeUndefined();
  });

  it('合集超长截到 600 字符加省略号（导出与注入预算可控）', () => {
    const long = Array.from({ length: MEMORIES_STORAGE_CAP + 1 }, (_, i) => ({
      date: '2026-01-01',
      text: '很长的摘要'.repeat(30) + String(i),
    }));
    const out = mergeMemoriesRolling(long);
    expect(out.memories[0].text.length).toBe(MEMORIES_MERGED_MAX_CHARS);
    expect(out.memories[0].text.endsWith('…')).toBe(true);
  });

  it('pinned 不在参数里——结构化字段永不进摘要合并（编译即守）', () => {
    // 本条只是文档化：函数签名只收 SessionMemory[]，pinned 是另一列另一个类型
    expect(MEMORIES_KEEP_RECENT).toBeLessThan(MEMORIES_STORAGE_CAP);
  });
});
