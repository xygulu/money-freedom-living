// C4 内容层文件读写测试：真临时目录往返（后台编辑的是源文件，写坏就是事故）。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listAdminBooks,
  readAdminBook,
  readPracticeNotes,
  validateSaveShape,
  writeAdminBook,
  writePracticeTopics,
  type AdminBookState,
} from '@/lib/admin-content';

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
  daily: {
    'zh-CN': [{ text: '签·甲', type: 'observation', stages: [1], reflection: '问一句', topics: ['self-worth'] }],
    en: [{ text: 'Card A', type: 'observation', stages: [1], reflection: 'Ask one', topics: ['self-worth'] }],
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

  it('source 保真：原本没有 source.md 且素材为空 → 写回不凭空造文件（v1 就没有）', () => {
    seedBook('test-book');
    const state = readAdminBook('test-book', root)!;
    expect(state.source).toBe('');
    writeAdminBook('test-book', state, root);
    expect(existsSync(join(root, 'test-book', 'source.md'))).toBe(false);
  });

  it('lamps.md 正文里的既有注释写回时保留（AI 起草新建的才用标准注释）', () => {
    seedBook('test-book');
    writeFileSync(join(root, 'test-book', 'lamps.md'), matter.stringify('老编辑留下的注释', { stages: {} }));
    writeAdminBook('test-book', baseState(), root);
    const { content } = matter(readFileSync0(join(root, 'test-book', 'lamps.md')));
    expect(content).toContain('老编辑留下的注释');
  });
});

describe('一签池读写（C4b）', () => {
  it('pool.json 往返逐字段一致，且保持「每条一行内联 JSON」格式（diff 干净）', () => {
    seedBook('test-book');
    const state = baseState();
    state.daily['zh-CN'] = [
      { text: '签·甲', type: 'observation', stages: [1, 2], reflection: '问甲', topics: ['self-worth', 'allowing'] },
      { text: '签·乙', type: 'way', stages: [3], reflection: '问乙', topics: ['allowing'] },
    ];
    writeAdminBook('test-book', state, root);
    const raw = readFileSync0(join(root, 'test-book', 'zh-CN', 'daily', 'pool.json'));
    expect(raw).toContain('  {"text":"签·甲"'); // 每条一行、2 空格缩进
    const once = readAdminBook('test-book', root)!;
    expect(once.daily['zh-CN']).toEqual(state.daily['zh-CN']);
    writeAdminBook('test-book', once, root);
    expect(readAdminBook('test-book', root)!.daily['zh-CN']).toEqual(state.daily['zh-CN']);
  });

  it('坏 pool.json / 缺目录按空池展示（计数 0），保存时覆盖写新池', () => {
    seedBook('test-book');
    writeFileSync(join(root, 'test-book', 'zh-CN', 'daily', 'pool.json'), '{oops');
    expect(readAdminBook('test-book', root)!.daily['zh-CN']).toEqual([]);
    const state = baseState();
    writeAdminBook('test-book', state, root);
    expect(readAdminBook('test-book', root)!.daily['zh-CN']).toHaveLength(1);
  });
});

describe('practices 打标（writePracticeTopics 字符串手术）', () => {
  it('插入 topics 行 / 替换既有行，frontmatter 其余字节与正文原样', () => {
    const before = [
      '---',
      'date: 2026-09-08',
      'type: fact',
      'stage: 3',
      'tags: [允许清单, 实验]',
      '---',
      '',
      '# 正文标题',
      '',
      '正文不动。',
    ].join('\n');
    writeFileSync(join(root, 'n1.md'), before);
    writePracticeTopics('n1.md', ['allowing'], root);
    const after = readFileSync0(join(root, 'n1.md'));
    expect(after).toContain('topics: [allowing]');
    expect(after).toContain('tags: [允许清单, 实验]');
    expect(after).toContain('date: 2026-09-08');
    expect(after).toContain('正文不动。');
    expect(readPracticeNotes(root)[0]).toMatchObject({ file: 'n1.md', topics: ['allowing'], tags: ['允许清单', '实验'] });

    writePracticeTopics('n1.md', ['self-worth', 'parents'], root);
    const twice = readFileSync0(join(root, 'n1.md'));
    expect(twice.match(/topics:/g)).toHaveLength(1); // 替换而非追加
    expect(readPracticeNotes(root)[0]?.topics).toEqual(['self-worth', 'parents']);
  });

  it('不存在的笔记抛错', () => {
    expect(() => writePracticeTopics('ghost.md', ['allowing'], root)).toThrow('笔记不存在');
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

  it('一签的坏 type / 越界 stages / 未知 topics 被点名（C4b）', () => {
    const state = baseState();
    state.daily['zh-CN'] = [
      { text: 'a', type: 'quote', stages: [9], reflection: 'r', topics: ['nope'] },
    ];
    const errors = validateSaveShape(state);
    expect(errors.some((e) => e.includes('type 必须是'))).toBe(true);
    expect(errors.some((e) => e.includes('stages'))).toBe(true);
    expect(errors.some((e) => e.includes('topics 未知命题 nope'))).toBe(true);
  });

  it('非对象直接报错不抛', () => {
    expect(validateSaveShape(null)).toEqual(['state 不是对象']);
  });
});

function readFileSync0(path: string): string {
  if (!existsSync(path)) throw new Error(`missing: ${path}`);
  return readFileSync(path, 'utf8');
}
