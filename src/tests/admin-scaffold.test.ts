// 后台新建书骨架测试：真临时目录往返（与 admin-content.test 同款纪律——写坏源文件是事故）。
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBookSkeleton, isValidBookId, suggestBookId } from '@/lib/admin-scaffold';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mfl-scaffold-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('isValidBookId（kebab-case 闸）', () => {
  it('合法：小写/数字/单连字符段', () => {
    expect(isValidBookId('money-freedom')).toBe(true);
    expect(isValidBookId('book-abc123')).toBe(true);
    expect(isValidBookId('a')).toBe(true);
  });

  it('非法：大写/下划线/开头结尾连字符/空串/路径穿越', () => {
    expect(isValidBookId('My-Book')).toBe(false);
    expect(isValidBookId('my_book')).toBe(false);
    expect(isValidBookId('-abc')).toBe(false);
    expect(isValidBookId('abc-')).toBe(false);
    expect(isValidBookId('')).toBe(false);
    expect(isValidBookId('a//b')).toBe(false);
    expect(isValidBookId('..')).toBe(false);
  });
});

describe('suggestBookId（留空自动生成）', () => {
  it('book-<base36 时间戳> 格式且本身合法', () => {
    const id = suggestBookId(new Date(0));
    expect(id).toMatch(/^book-[a-z0-9]+$/);
    expect(isValidBookId(id)).toBe(true);
    // 同一时刻稳定，不同时刻不同
    expect(suggestBookId(new Date(0))).toBe(id);
    expect(suggestBookId(new Date(1))).not.toBe(id);
  });
});

describe('createBookSkeleton（骨架落盘）', () => {
  it('生成 meta/lamps + en/zh-CN 的 journey 1 段与空一签池，status: draft', () => {
    createBookSkeleton({ bookId: 'test-book', titleZh: '测试之书', titleEn: 'Test Book', author: '某人' }, root);
    const bookDir = join(root, 'test-book');
    expect(existsSync(join(bookDir, 'meta.md'))).toBe(true);
    expect(existsSync(join(bookDir, 'lamps.md'))).toBe(true);
    for (const locale of ['en', 'zh-CN']) {
      expect(readdirSync(join(bookDir, locale, 'journey'))).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(bookDir, locale, 'daily', 'pool.json'), 'utf8'))).toEqual([]);
    }
    const meta = readFileSync(join(bookDir, 'meta.md'), 'utf8');
    expect(meta).toContain('id: test-book');
    expect(meta).toContain('status: draft');
    expect(meta).toContain('"测试之书"'); // 四语书名占位（zh-CN 真名，其余 TODO 回落）
    expect(meta).toContain('"某人"');
    // zh-CN 文件名用真书名（与 CLI 脚手架同款），en 用 stage-1
    expect(existsSync(join(bookDir, 'zh-CN', 'journey', '1-测试之书.md'))).toBe(true);
    expect(existsSync(join(bookDir, 'en', 'journey', '1-stage-1.md'))).toBe(true);
  });

  it('随带素材时落 source.md；不带则不造文件（v1 就没有）', () => {
    createBookSkeleton({ bookId: 'with-src', titleZh: '有素材', source: '第一段素材。\n第二段。' }, root);
    expect(readFileSync(join(root, 'with-src', 'source.md'), 'utf8')).toContain('第一段素材');

    createBookSkeleton({ bookId: 'no-src', titleZh: '无素材' }, root);
    expect(existsSync(join(root, 'no-src', 'source.md'))).toBe(false);
  });

  it('目录已存在 / 非法 bookId 抛错且不落盘', () => {
    createBookSkeleton({ bookId: 'dup', titleZh: '第一本' }, root);
    expect(() => createBookSkeleton({ bookId: 'dup', titleZh: '第二本' }, root)).toThrow('book_exists');
    expect(() => createBookSkeleton({ bookId: 'Bad_Id', titleZh: '非法' }, root)).toThrow('bad_book_id');
    expect(existsSync(join(root, 'Bad_Id'))).toBe(false);
    // 第一本安然无恙（先查重后写入）
    expect(readFileSync(join(root, 'dup', 'meta.md'), 'utf8')).toContain('第一本');
  });
});
