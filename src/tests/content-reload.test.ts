// C3（发布即生效）语义测试：content.ts 运行时读磁盘 content.json。
// 三条要守住的语义：
//   1. 磁盘读不到/坏 JSON → 回落静态打包副本（内容层永不挂掉）；
//   2. reloadContent() → 热替换内存 bundle（新书/新灯下一次访问即可见）；
//   3. reload 时磁盘坏了 → 不换旧 bundle（绝不清空内容层，发布失败旧内容继续服务）。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ disk: 'MISSING' as string })); // 'MISSING' = readFileSync 直接抛（文件不存在）

const fixtures = vi.hoisted(() => {
  const lamp = (kind: string) => ({
    kind,
    topic: 'self-worth',
    needsAction: false,
    promptHint: '',
    label: { en: kind, 'zh-CN': kind, 'zh-TW': kind, ja: kind },
    hint: { en: '', 'zh-CN': '', 'zh-TW': '', ja: '' },
  });
  const bundle = (ids: string[], lamps: Record<string, Record<number, unknown[]>>, builtAt: string) => ({
    books: ids.map((id) => ({ id, title: { en: id, 'zh-CN': id }, author: '', source: '', topics: ['self-worth'], status: 'active', note: '' })),
    journey: {},
    daily: {},
    lamps,
    practices: [],
    safety: {},
    builtAt,
  });
  return {
    // 静态打包副本（构建期打进部署包的那份）
    pack: bundle(['money-freedom'], { 'money-freedom': { 1: [lamp('mf_pack_lamp')] } }, '2026-09-20T00:00:00.000Z'),
    // 磁盘上的新版本：多一本书、多一盏灯
    fresh: bundle(
      ['money-freedom', 'second-book'],
      { 'money-freedom': { 1: [lamp('mf_pack_lamp'), lamp('mf_new_lamp')] }, 'second-book': { 1: [lamp('sb_lamp')] } },
      '2026-09-21T00:00:00.000Z',
    ),
  };
});

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readFileSync: () => {
    if (state.disk === 'MISSING') throw new Error('ENOENT: no such file or directory');
    return state.disk;
  },
}));

vi.mock('@/generated/content.json', () => ({ default: fixtures.pack }));

async function loadContent() {
  return await import('@/lib/content');
}

beforeEach(() => {
  vi.resetModules();
  state.disk = 'MISSING';
});

describe('C3 内容装载与热重载', () => {
  it('磁盘读不到 → 回落静态打包副本', async () => {
    const c = await loadContent();
    expect(c.getBooks()).toHaveLength(1);
    expect(c.getBooks()[0]?.id).toBe('money-freedom');
    expect(c.getBookLamps('money-freedom')?.[1]?.map((l) => l.kind)).toEqual(['mf_pack_lamp']);
    expect(c.getBook('second-book')).toBeNull();
  });

  it('磁盘是坏 JSON → 同样回落打包副本，内容层不挂', async () => {
    state.disk = '{ this is not json';
    const c = await loadContent();
    expect(c.getBooks()).toHaveLength(1);
    expect(c.getBookLamps('money-freedom')?.[1]?.[0]?.kind).toBe('mf_pack_lamp');
  });

  it('进程启动时磁盘有效 → 直接装载磁盘版本（不等 reload）', async () => {
    state.disk = JSON.stringify(fixtures.fresh);
    const c = await loadContent();
    expect(c.getBooks().map((b) => b.id)).toEqual(['money-freedom', 'second-book']);
    expect(c.getBookLamps('second-book')?.[1]?.[0]?.kind).toBe('sb_lamp');
  });

  it('reloadContent 热替换：旧 bundle 起步，换盘后新书/新灯即刻可见', async () => {
    const c = await loadContent(); // 起步 = 打包副本
    expect(c.getBooks()).toHaveLength(1);
    state.disk = JSON.stringify(fixtures.fresh);
    const reloaded = c.reloadContent();
    expect(reloaded.builtAt).toBe(fixtures.fresh.builtAt);
    expect(c.getBooks().map((b) => b.id)).toEqual(['money-freedom', 'second-book']);
    expect(c.getBookLamps('money-freedom')?.[1]?.map((l) => l.kind)).toEqual(['mf_pack_lamp', 'mf_new_lamp']);
  });

  it('reload 时磁盘坏了 → 不换旧 bundle（保住刚发布的内容，不清空也不回退打包副本）', async () => {
    state.disk = JSON.stringify(fixtures.fresh);
    const c = await loadContent();
    state.disk = '{ broken';
    const still = c.reloadContent();
    expect(still.builtAt).toBe(fixtures.fresh.builtAt);
    expect(c.getBooks()).toHaveLength(2);
    expect(c.getBookLamps('money-freedom')?.[1]).toHaveLength(2);
  });

  it('reload 时磁盘读不到 → 同样不换旧 bundle', async () => {
    const c = await loadContent(); // 打包副本起步
    state.disk = JSON.stringify(fixtures.fresh);
    c.reloadContent();
    state.disk = 'MISSING';
    const still = c.reloadContent();
    expect(still.builtAt).toBe(fixtures.fresh.builtAt);
    expect(c.getBooks()).toHaveLength(2);
  });
});
