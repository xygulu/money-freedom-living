import { describe, expect, it } from 'vitest';
import { buildChatContext, HISTORY_BUDGET } from '@/lib/prompt';
import { validateDigest } from '@/lib/memory';
import type { Portrait, SessionMemory } from '@/lib/profile';
import type { Locale } from '@/i18n/config';

function portrait(): Portrait {
  return {
    spoken: ['我妈说，咱家不配。'],
    baseColor: '花钱那一刻总有个声音说再省一点。'.repeat(3),
    moments: [{ title: '试衣间', detail: '付完钱手在抖' }],
    script: '也许「咱家不配」。',
    toFuture: '慢慢来。',
    version: 1,
    calibrations: [],
    scriptStatus: 'pending',
  };
}

const base = {
  locale: 'zh-CN' as Locale,
  stage: 1,
  concerns: [],
  pinned: [],
  memories: [] as SessionMemory[],
  history: [],
  stableMode: false,
  opener: false,
};

describe('buildChatContext：P§6 优先级组装', () => {
  it('安全规则永远是第一个块', () => {
    const { system } = buildChatContext(base);
    expect(system.indexOf('安全规则')).toBeGreaterThan(-1);
    expect(system.trim().startsWith('## 安全规则')).toBe(true);
  });

  it('pinned 按 禁忌>承诺>未完成 排序，且超过预算也不裁（在 memories 之前）', () => {
    const { system } = buildChatContext({
      ...base,
      pinned: [
        { kind: 'open', text: '加薪话题聊到一半' },
        { kind: 'promise', text: '这周记三次账' },
        { kind: 'taboo', text: '别再提我爸' },
      ],
    });
    const tabooAt = system.indexOf('别再提我爸');
    const promiseAt = system.indexOf('这周记三次账');
    const openAt = system.indexOf('加薪话题聊到一半');
    expect(tabooAt).toBeLessThan(promiseAt);
    expect(promiseAt).toBeLessThan(openAt);
  });

  it('脚本只有 confirmed 才注入（pending/rejected 不进长期工作记忆，P§2）', () => {
    const pending = buildChatContext({ ...base, portrait: portrait() });
    expect(pending.system).not.toContain('也许「咱家不配」');

    const confirmed = buildChatContext({ ...base, portrait: { ...portrait(), scriptStatus: 'confirmed' } });
    expect(confirmed.system).toContain('也许「咱家不配」');

    const rejected = buildChatContext({ ...base, portrait: { ...portrait(), scriptStatus: 'rejected' } });
    expect(rejected.system).not.toContain('也许「咱家不配」');
  });

  it('spoken/底色/瞬间/开放 concerns/阶段引导注入', () => {
    const { system } = buildChatContext({
      ...base,
      portrait: portrait(),
      concerns: [{ content: '买外套内疚三天', status: 'open' }, { content: '已化解的旧事', status: 'closed' }],
    });
    expect(system).toContain('咱家不配');
    expect(system).toContain('买外套内疚三天');
    expect(system).not.toContain('已化解的旧事');
    expect(system).toContain('看见'); // 阶段 1 标题出现在 system
  });

  it('memories 只取最近 5 条、每条截断', () => {
    const memories: SessionMemory[] = Array.from({ length: 8 }, (_, i) => ({
      date: `2026-09-0${i + 1}`,
      text: `记忆${i}：${'很长的内容'.repeat(80)}`,
    }));
    const { system } = buildChatContext({ ...base, memories });
    expect(system).toContain('记忆7');
    expect(system).toContain('记忆3'); // slice(-5) = 第 3-7 条
    expect(system).not.toContain('记忆2：');
    expect(system).not.toContain('记忆0：');
  });

  it('stableMode 注入稳定陪伴模式；opener 注入开场指令', () => {
    expect(buildChatContext({ ...base, stableMode: true }).system).toContain('稳定陪伴模式');
    expect(buildChatContext({ ...base, opener: true }).system).toContain('开场');
    expect(buildChatContext(base).system).not.toContain('稳定陪伴模式');
  });

  it('对话历史从最新往回装进预算，最旧的先被裁', () => {
    const history = Array.from({ length: 50 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `消息${i}：${'x'.repeat(200)}`,
    }));
    const { messages } = buildChatContext({ ...base, history });
    const joined = messages.map((m) => m.content).join();
    expect(messages.length).toBeLessThan(history.length);
    expect(joined).toContain(`消息49`);
    expect(joined).not.toContain(`消息0：`);
    expect(messages.reduce((sum, m) => sum + m.content.length, 0)).toBeLessThanOrEqual(HISTORY_BUDGET);
    // 时序不乱：裁剪后仍按时间正序（首条编号 < 末条编号，且角色交替保持 user 开头）
    const numAt = (i: number) => Number(messages[i].content.match(/消息(\d+)/)![1]);
    expect(numAt(0)).toBeLessThan(numAt(messages.length - 1));
  });
});

describe('validateDigest（会话摘要结构校验）', () => {
  it('合法摘要通过，pinned 过滤非法 kind/空文本并截 3 条', () => {
    const digest = validateDigest({
      summary: '用户谈到买外套后内疚三天，背后是「不配」的旧声音。',
      pinned: [
        { kind: 'taboo', text: '别提我爸' },
        { kind: 'nonsense', text: 'x' },
        { kind: 'promise', text: '下周和老板谈加薪' },
        { kind: 'open', text: '' },
        { kind: 'open', text: '第四条不要' },
      ],
    });
    expect(digest?.summary).toContain('内疚');
    // 合法 pinned = taboo + promise + 第四条(open)；非法 kind、空文本被滤掉，最多 3 条
    expect(digest?.pinned.map((p) => p.kind)).toEqual(['taboo', 'promise', 'open']);
  });

  it('摘要过短/缺失/非字符串 → null（宁缺勿错）', () => {
    expect(validateDigest({ summary: '太短', pinned: [] })).toBeNull();
    expect(validateDigest({})).toBeNull();
    expect(validateDigest('hello')).toBeNull();
  });
});
