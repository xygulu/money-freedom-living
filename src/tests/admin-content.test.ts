// C4 内容层文件读写测试：真临时目录往返（后台编辑的是源文件，写坏就是事故）。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listAdminBooks, readAdminBook, validateSaveShape, writeAdminBook, type AdminBookState } from '@/lib/admin-content';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mfl-admin-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const baseState = (): AdminBookState => ({
  meta: {
    id: 'test-book',
    title: { en: 'Test', 'zh-CN': '测试书', 'zh-TW': '測試書', ja: 'テスト' },
    author: '某人',
    source: '某出版社 2020',
    topics: ['self-worth'],
    status: 'draft',
    note: '这本书带读者看见什么',
  },
  source: '素材第一段。\n素材第二段。',
  journey: {
    'zh-CN': [
      {
        file: '1.md',
        id: 1,
        title: '看见',
        goal: '看见旧脚本',
        weeks: 3,
        exercises: ['记一件小事'],
        do: ['承接'],
        dont: ['说教'],
        advance_when: ['能说出旧脚本'],
        ritual: '无',
        skippable: true,
        free_alt: '不花钱的版本',
        topics: ['self-worth'],
        body: '正文内容，超过一百个字符的正文内容。'.repeat(5),
      },
    ],
    en: [],
  },
  lamps: {
    1: [
      {
        kind: 'testbook_stage1_seen',
        topic: 'self-worth',
        needsAction: false,
        promptHint: '当读者能认出旧脚本时视为到达',
        label: { en: 'Seen', 'zh-CN': '看见', 'zh-TW': '看見', ja: '見えた' },
        hint: { en: 'not yet', 'zh-CN': '还没到', 'zh-TW': '還沒到', ja: 'まだ' },
      },
    ],
  },
});

function seedBook(id: string): void {
  const dir = join(root, id);
  mkdirSync(join(dir, 'zh-CN', 'journey'), { recursive: true });
  mkdirSync(join(dir, 'en', 'journey'), { recursive: true });
  mkdirSync(join(dir, 'zh-CN', 'daily'), { recursive: true });
  writeFileSync(join(dir, 'meta.md'), matter.stringify('说明文字', { id, title: { en: 'T', 'zh-CN': '测' }, status: 'draft', topics: ['self-worth'] }));
  writeFileSync(join(dir, 'zh-CN', 'daily', 'pool.json'), '[{"text":"a"}]');
}

describe('writeAdminBook / readAdminBook 往返', () => {
  it('写出的 journey frontmatter 能被 gray-matter 原样读回（ai_stance 嵌套 / topics / free_alt）', () => {
    seedBook('test-book');
    writeAdminBook('test-book', baseState(), root);
    const { data, content } = matter(readFileSync0(join(root, 'test-book', 'zh-CN', 'journey', '1.md')));
    expect(data.id).toBe(1);
    expect(data.title).toBe('看见');
    expect(data.weeks).toBe(3);
    expect(data.ai_stance).toEqual({ do: ['承接'], dont: ['说教'] });
    expect(data.advance_when).toEqual(['能说出旧脚本']);
    expect(data.skippable).toBe(true);
    expect(data.free_alt).toBe('不花钱的版本');
    expect(data.topics).toEqual(['self-worth']);
    expect(content.trim()).toContain('正文内容');
  });

  it('round trip：写 → 读 → 写 → 读，编辑态逐字段一致', () => {
    seedBook('test-book');
    writeAdminBook('test-book', baseState(), root);
    const once = readAdminBook('test-book', root);
    expect(once).not.toBeNull();
    writeAdminBook('test-book', once!, root);
    const twice = readAdminBook('test-book', root);
    expect(twice).toEqual(once);
    expect(twice!.journey['zh-CN']?.[0]?.do).toEqual(['承接']);
    expect(twice!.lamps['1']?.[0]?.label.ja).toBe('見えた');
    expect(twice!.source).toContain('素材第二段');
  });

  it('写 journey 先清旧文件：不留过期段（同名不同 id 会产出重复段）', () => {
    seedBook('test-book');
    writeFileSync(join(root, 'test-book', 'zh-CN', 'journey', '9-旧段.md'), '---\nid: 9\n---\n旧');
    const state = baseState();
    writeAdminBook('test-book', state, root);
    const files = readdirSync(join(root, 'test-book', 'zh-CN', 'journey')).filter((f) => f.endsWith('.md'));
    expect(files).toEqual(['1.md']);
  });

  it('meta id 以目录名为准（表单传别的 id 也不改写）', () => {
    seedBook('test-book');
    const state = baseState();
    state.meta.id = 'hacked-id';
    writeAdminBook('test-book', state, root);
    const { data } = matter(readFileSync0(join(root, 'test-book', 'meta.md')));
    expect(data.id).toBe('test-book');
  });

  it('不存在的书抛错', () => {
    expect(() => writeAdminBook('ghost', baseState(), root)).toThrow('书不存在');
  });

  it('free_alt 空串不写键（可选字段语义，build-content 允许缺省）', () => {
    seedBook('test-book');
    const state = baseState();
    state.journey['zh-CN']![0]!.free_alt = '';
    writeAdminBook('test-book', state, root);
    const { data } = matter(readFileSync0(join(root, 'test-book', 'zh-CN', 'journey', '1.md')));
    expect(data.free_alt).toBeUndefined();
  });

  it('skippable 三态：源文件没有该键 → 读出 null → 写回仍不写键（v1 第 2 段的保真）', () => {
    seedBook('test-book');
    writeFileSync(join(root, 'test-book', 'zh-CN', 'journey', '1.md'), matter.stringify('正文内容超过一百个字符的正文内容。'.repeat(5), { id: 1, title: '看见', goal: 'g', weeks: 3, exercises: ['x'], ai_stance: { do: ['a'], dont: ['b'] }, advance_when: ['c'], ritual: '无' }));
    const state = readAdminBook('test-book', root)!;
    expect(state.journey['zh-CN']![0]!.skippable).toBeNull();
    writeAdminBook('test-book', state, root);
    const { data } = matter(readFileSync0(join(root, 'test-book', 'zh-CN', 'journey', '1.md')));
    expect(data.skippable).toBeUndefined();
  });

  it('lamps.md 正文里的既有注释写回时保留（AI 起草新建的才用标准注释）', () => {
    seedBook('test-book');
    writeFileSync(join(root, 'test-book', 'lamps.md'), matter.stringify('老编辑留下的注释', { stages: {} }));
    writeAdminBook('test-book', baseState(), root);
    const { content } = matter(readFileSync0(join(root, 'test-book', 'lamps.md')));
    expect(content).toContain('老编辑留下的注释');
  });
});

describe('listAdminBooks（后台书清单：源文件直读，draft 也看得到）', () => {
  it('统计段 / 灯 / 一签数量，未发布的草稿书也在列', () => {
    seedBook('test-book');
    writeAdminBook('test-book', baseState(), root);
    const rows = listAdminBooks(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'test-book', status: 'draft', stageCount: 1, lampCount: 1, dailyCount: 1 });
  });

  it('目录不存在返回空数组；坏 pool.json 按 0 计', () => {
    expect(listAdminBooks(join(root, 'nope'))).toEqual([]);
    seedBook('bad-pool');
    writeFileSync(join(root, 'bad-pool', 'zh-CN', 'daily', 'pool.json'), '{oops');
    expect(listAdminBooks(root).find((r) => r.id === 'bad-pool')?.dailyCount).toBe(0);
  });
});

describe('validateSaveShape（只拦会写坏文件的垃圾，内容质量归发布闸）', () => {
  it('合法状态零错误', () => {
    expect(validateSaveShape(baseState())).toEqual([]);
  });

  it('坏 status / 未知命题 / 段 id 重复 / 灯缺 kind / 灯段号非数字全被点名', () => {
    const state = baseState();
    state.meta.status = 'published' as AdminBookState['meta']['status'];
    state.meta.topics = ['nope'];
    (state.journey['zh-CN'] as AdminBookState['journey']['zh-CN']).push({ ...(state.journey['zh-CN'] as AdminBookState['journey']['zh-CN'])[0]!, file: 'x.md' });
    state.lamps['x'] = [{ ...(state.lamps['1']![0]!), kind: '' }];
    const errors = validateSaveShape(state);
    expect(errors.some((e) => e.includes('status'))).toBe(true);
    expect(errors.some((e) => e.includes('未知命题'))).toBe(true);
    expect(errors.some((e) => e.includes('重复'))).toBe(true);
    expect(errors.some((e) => e.includes('kind 缺'))).toBe(true);
    expect(errors.some((e) => e.includes('段号 x'))).toBe(true);
  });

  it('非对象直接报错不抛', () => {
    expect(validateSaveShape(null)).toEqual(['state 不是对象']);
  });
});

function readFileSync0(path: string): string {
  if (!existsSync(path)) throw new Error(`missing: ${path}`);
  return readFileSync(path, 'utf8');
}
