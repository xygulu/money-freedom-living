// 新书骨架生成（V0.2 批 C4 后续：后台「输入书名建书」）。
// 模板与 scripts/new-book.mjs 同源——CLI 那份是运营终端入口，这份是后台路由入口；
// 改模板两处同步（build-content.mjs 有硬编码副本的先例）。目录/文件契约以
// scripts/build-content.mjs 的校验为准。
//
// 生成的是 status: draft 的草稿书：骨架自带 TODO 占位，pnpm build-content 能编译
// 通过，但发布闸（active 书硬校验）会挡住它直到内容填齐或 AI 起草 + 人工校正完成。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOOKS_DIR } from './admin-content';

/** 与 new-book.mjs 一致：kebab-case（小写字母/数字/连字符） */
export function isValidBookId(id: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id);
}

/** 未指定 bookId 时的自动生成：book-<base36 时间戳>，丑但零依赖零冲突 */
export function suggestBookId(now: Date = new Date()): string {
  return `book-${now.getTime().toString(36)}`;
}

export interface SkeletonInput {
  bookId: string;
  titleZh: string;
  titleEn?: string;
  author?: string;
  /** 可选：随建随存的初始素材（工作台起草框同源） */
  source?: string;
}

/** 建骨架（目录已存在时抛错，由调用方先行查重）。dir 参数供测试指向临时目录。 */
export function createBookSkeleton(input: SkeletonInput, dir: string = BOOKS_DIR): void {
  const { bookId, titleZh } = input;
  if (!isValidBookId(bookId)) throw new Error(`bad_book_id: ${bookId}`);
  if (existsSync(join(dir, bookId))) throw new Error(`book_exists: ${bookId}`);

  const root = join(dir, bookId);
  mkdirSync(root, { recursive: true });
  const todo = (lang: string) =>
    lang === 'zh-CN' ? titleZh.trim() : input.titleEn?.trim() || `<TODO: ${lang} 书名>`;
  // YAML 值一律 JSON.stringify——书名里带「: 」会把 frontmatter 解析炸掉
  const q = (s: string) => JSON.stringify(s);

  // ---- meta.md ----
  const meta = `---
id: ${bookId}
title:
${['en', 'zh-CN', 'zh-TW', 'ja']
  .map((l) => `  ${l}: ${q(todo(l))}`)
  .join('\n')}
author: ${q(input.author?.trim() || '<TODO: 作者>')}
source: ${q(input.source?.trim() ? '（见素材框）' : '<TODO: 出处（书名/出版社/年份）>')}
topics:
  - self-worth # TODO: 换成这本书真正覆盖的命题（六命题枚举见 content.ts TOPICS / docs/02 §10）
status: draft
---

<TODO: 一段话——这本书给读者的是什么？它想带读者从哪里走到哪里？>
`;
  writeFileSync(join(root, 'meta.md'), meta);

  // ---- source.md（仅当随带了素材；工作台「素材随请求先落盘」同一文件） ----
  if (input.source?.trim()) {
    writeFileSync(join(root, 'source.md'), `${input.source.trim()}\n`);
  }

  // ---- lamps.md ----
  const lamps = `---
# 灯判定表：灯的形状与文案属于书（V0.2 B4）。字段语义见
# content/books/money-freedom/lamps.md 头注；kind 跨书唯一、topic ∈ 六命题、
# label/hint 四语非空、promptHint 面向评估 LLM（中文内部备注）。
stages: {}
# 可不手填：工作台「AI 起草 journey + 灯表」会连灯表一起起草，人工校正即可。
`;
  writeFileSync(join(root, 'lamps.md'), lamps);

  // ---- journey + daily（en + zh-CN 各一套）----
  const journeyMd = (locale: string, stageId: number) => {
    const t = todo(locale);
    return `---
id: ${stageId}
title: ${q(stageId > 1 ? `<TODO: 第 ${stageId} 段短名——比如 v1 的「松动」>` : '<TODO: 第一段短名——比如 v1 的「看见」>')}
goal: ${q('<TODO: 这一段要带读者看见什么（一句话，会进评估 prompt 当标尺）>')}
weeks: 3
exercises:
  - ${q('<TODO: 这一阶段的日常练习（一行一个）>')}
ai_stance:
  do:
    - ${q('<TODO: 陪伴者在这一段该做的>')}
  dont:
    - ${q('<TODO: 陪伴者在这一段不该做的>')}
advance_when:
  - ${q('<TODO: 达到什么程度算走完这一段（评估标尺，会进 prompt）>')}
ritual: ${q('<TODO: 这一段的仪式（可选，没有就写「无」）>')}
skippable: true
---

# 段 ${stageId} · ${t}

## 这个阶段在做什么

<TODO: 正文——这一段的心法与边界。这段文字是给内容维护者与 AI 上下文看的。>
`;
  };
  const emptyPool = '[]\n';
  for (const locale of ['en', 'zh-CN']) {
    mkdirSync(join(root, locale, 'journey'), { recursive: true });
    mkdirSync(join(root, locale, 'daily'), { recursive: true });
    const fileName = locale === 'zh-CN' ? `1-${titleZh.trim()}.md` : '1-stage-1.md';
    writeFileSync(join(root, locale, 'journey', fileName), journeyMd(locale, 1));
    writeFileSync(join(root, locale, 'daily', 'pool.json'), emptyPool);
  }
}
