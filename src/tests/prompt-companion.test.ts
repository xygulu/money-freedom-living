/**
 * 陪伴者弹层轻量 system 组装单测（2026-09-18 弹层 chat 化）。
 *
 * buildCompanionContext 与 buildChatContext 刻意分开：弹层是轻场景——
 * 不注入每日两问协议 / 五类失败接法 / 阶段实践 / 画像 / pinned / 命题线；
 * 只带安全红线 + 语言钉死 + 少量记忆 + 气泡 openingLine。
 * 这组测试把"轻"钉死：重了就违背弹层的产品语义。
 */
import { describe, expect, it } from 'vitest';
import { buildCompanionContext, clampHistory, COMPANION_HISTORY_BUDGET } from '@/lib/prompt-companion';
import type { ChatTurn } from '@/lib/chat';
import type { Locale } from '@/i18n/config';

const baseInput = {
  locale: 'zh-CN' as Locale,
  stage: 2,
  memories: [] as { date: string; text: string }[],
  concerns: [] as { content: string; status: string }[],
  history: [] as ChatTurn[],
  tz: 'Asia/Shanghai',
};

describe('buildCompanionContext：轻量边界（重了 = 错）', () => {
  it('不注入每日两问协议', () => {
    const ctx = buildCompanionContext(baseInput);
    expect(ctx.system).not.toContain('一天最多两问');
    expect(ctx.system).not.toContain('At most two questions');
  });

  it('不注入五类失败接法', () => {
    const ctx = buildCompanionContext(baseInput);
    expect(ctx.system).not.toContain('失败接法');
    expect(ctx.system).not.toContain('failure');
  });

  it('不注入阶段实践 / 画像 / pinned / 命题线（stage=3 也不注），整体保持轻量', () => {
    const ctx = buildCompanionContext({ ...baseInput, stage: 3 });
    // buildChatContext 独有块头（pinned/阶段/实践/画像）一个都不出现；
    // SAFETY/LANGUAGE 共享块里对 pinned/画像的引用属于红线文本，不算注入
    expect(ctx.system).not.toContain('## Pinned');
    expect(ctx.system).not.toContain('## 当前阶段：');
    expect(ctx.system).not.toContain('## 创造者的实践经验');
    expect(ctx.system).not.toContain('## 金钱画像');
    // 轻量的量化口径：全程 system < 4500 字符（/chat 预算 12000）
    expect(ctx.system.length).toBeLessThan(4_500);
    expect(ctx.messages).toEqual([]);
  });

  it('注入安全规则与语言红线（两条硬约束一行不少）', () => {
    const ctx = buildCompanionContext(baseInput);
    expect(ctx.system).toContain('安全规则');
    expect(ctx.system).toContain('语言');
  });
});

describe('buildCompanionContext：素材注入', () => {
  it('memories > 3 只取末 3 条、每条截 140 字符', () => {
    const memories = [1, 2, 3, 4, 5].map((i) => ({ date: `2026-09-0${i}`, text: `记忆${i}${'长'.repeat(200)}` }));
    const ctx = buildCompanionContext({ ...baseInput, memories });
    expect(ctx.system).toContain('记忆3');
    expect(ctx.system).toContain('记忆5');
    expect(ctx.system).not.toContain('记忆1');
    expect(ctx.system).not.toContain('记忆2');
    // 截断：单条不超 140 字符（含前缀前本体）
    expect(ctx.system).not.toContain('长'.repeat(141));
  });

  it('concerns 只收 open 状态、最多 2 条（取数组末尾 = 最近的）', () => {
    const concerns = [
      { content: '最旧的心事', status: 'open' },
      { content: '已关闭的心事', status: 'closed' },
      { content: '较近的心事', status: 'open' },
      { content: '最近的心事', status: 'open' },
    ];
    const ctx = buildCompanionContext({ ...baseInput, concerns });
    expect(ctx.system).toContain('较近的心事');
    expect(ctx.system).toContain('最近的心事');
    expect(ctx.system).not.toContain('已关闭的心事');
    expect(ctx.system).not.toContain('最旧的心事');
  });

  it('openingLine（气泡 nudge）注入，且按语言出模板', () => {
    const ctx = buildCompanionContext({ ...baseInput, openingLine: '上次你说想试试「不先还花呗」' });
    expect(ctx.system).toContain('上次你说想试试「不先还花呗」');
    expect(ctx.system).toContain('气泡刚跟他说的话');
    const en = buildCompanionContext({ ...baseInput, locale: 'en', openingLine: 'you mentioned trying' });
    expect(en.system).toContain('your bubble just said');
  });

  it('openingLine 为空/空白不注入', () => {
    const ctx = buildCompanionContext({ ...baseInput, openingLine: '   ' });
    expect(ctx.system).not.toContain('气泡刚跟他说的话');
  });
});

describe('clampHistory：超预算从最新往回裁', () => {
  it('保留最新、丢最老（预算 2000 字符，两条长消息撑爆它）', () => {
    const big = '字'.repeat(1_100);
    const history: ChatTurn[] = [
      { role: 'user', content: '最老的一条' },
      { role: 'assistant', content: big },
      { role: 'user', content: big },
      { role: 'assistant', content: '最新的一条' },
    ];
    const kept = clampHistory(history, COMPANION_HISTORY_BUDGET);
    expect(kept[kept.length - 1].content).toBe('最新的一条');
    expect(kept.some((t) => t.content === '最老的一条')).toBe(false);
    const total = kept.reduce((n, t) => n + t.content.length, 0);
    expect(total).toBeLessThanOrEqual(COMPANION_HISTORY_BUDGET);
  });

  it('空历史 → 空数组（opener 占位由 respondToMessage 兜底，与 /chat 同路径）', () => {
    expect(clampHistory([])).toEqual([]);
  });
});
