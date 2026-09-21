#!/usr/bin/env node
// 新书脚手架（V0.2 批 C1，docs/02 §20.3）：一条命令生成 content/books/<id>/ 目录骨架。
//
//   pnpm new-book <bookId> "<zh-CN 书名>" [--en "<en 书名>"]
//
// 生成的是 status: draft 的草稿书：骨架自带你必填的 TODO 占位，`pnpm build-content`
// 能编译通过（占位非空），但发布闸（C2：active 书的硬校验）会挡住它直到内容填齐。
// 目录/文件契约与 scripts/build-content.mjs 一致：改那边的校验前先看这边。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BOOKS_DIR = join(process.cwd(), 'content', 'books');
// 与 build-content.mjs 的 ENABLED_LOCALES 一致：journey/一签每本都要这两语
const LOCALES = ['en', 'zh-CN'];
const TITLE_LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja'];

const args = process.argv.slice(2);
const bookId = args[0];
const zhTitle = args[1];
const enIdx = args.indexOf('--en');
const enTitle = enIdx > -1 ? args[enIdx + 1] : null;

if (!bookId || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(bookId)) {
  console.error('用法：pnpm new-book <bookId> "<zh-CN 书名>" [--en "<en 书名>"]');
  console.error('bookId 必须是 kebab-case（小写字母/数字/连字符），如 "the-courage-to-be-disliked"');
  process.exit(1);
}
if (!zhTitle || !zhTitle.trim()) {
  console.error('缺 zh-CN 书名：pnpm new-book <bookId> "<zh-CN 书名>"');
  process.exit(1);
}
if (existsSync(join(BOOKS_DIR, bookId))) {
  console.error(`已存在：content/books/${bookId}/——不覆盖。要重来先删目录。`);
  process.exit(1);
}

const dir = join(BOOKS_DIR, bookId);
mkdirSync(dir, { recursive: true });
const todo = (lang) => (lang === 'zh-CN' ? zhTitle.trim() : enTitle?.trim() || `<TODO: ${lang} 书名>`);
// YAML 值一律 JSON.stringify——占位符里带「: 」会把 frontmatter 解析炸掉
const q = (s) => JSON.stringify(s);

// ---- meta.md ----
const meta = `---
id: ${bookId}
title:
${TITLE_LOCALES.map((l) => `  ${l}: ${q(todo(l))}`).join('\n')}
author: ${q('<TODO: 作者>')}
source: ${q('<TODO: 出处（书名/出版社/年份）>')}
topics:
  - self-worth # TODO: 换成这本书真正覆盖的命题（六命题枚举见 content.ts TOPICS / docs/02 §10）
status: draft
---

<TODO: 一段话——这本书给读者的是什么？它想带读者从哪里走到哪里？>

（V0.2 批 C1 脚手架生成；发布前把本文件与 journey/lamps/daily 的 TODO 全部填齐——
active 书会被发布闸硬校验：每段 ≥1 盏灯、一签池非空、各语言结构平行。）
`;
writeFileSync(join(dir, 'meta.md'), meta);

// ---- lamps.md ----
const lamps = `---
# 灯判定表：灯的形状与文案属于书（V0.2 B4）。字段语义见
# content/books/money-freedom/lamps.md 头注；kind 跨书唯一、topic ∈ 六命题、
# label/hint 四语非空、promptHint 面向评估 LLM（中文内部备注）。
stages: {}
# 示例（去掉注释、把段号与内容补齐）：
# stages:
#   1:
#     - kind: ${bookId.replace(/-/g, '')}_stage1_first
#       topic: self-worth
#       needsAction: false
#       promptHint: <给评估 LLM 的判定提示（中文，不面向用户）>
#       label:
#         en: "<TODO>"
#         zh-CN: "<TODO>"
#         zh-TW: "<TODO>"
#         ja: "<TODO>"
#       hint:
#         en: "<TODO>"
#         zh-CN: "<TODO>"
#         zh-TW: "<TODO>"
#         ja: "<TODO>"
`;
writeFileSync(join(dir, 'lamps.md'), lamps);

// ---- journey + daily（每开放语言一套）----
const journeyMd = (locale, stageId) => {
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
for (const locale of LOCALES) {
  mkdirSync(join(dir, locale, 'journey'), { recursive: true });
  mkdirSync(join(dir, locale, 'daily'), { recursive: true });
  writeFileSync(join(dir, locale, 'journey', `1-${locale === 'zh-CN' ? zhTitle.trim() : 'stage-1'}.md`), journeyMd(locale, 1));
  writeFileSync(join(dir, locale, 'daily', 'pool.json'), emptyPool);
}

console.log(`已生成 content/books/${bookId}/（status: draft）`);
console.log('  meta.md / lamps.md / en|zh-CN 的 journey 1 段 + 空一签池');
console.log('下一步：');
console.log('  1. 把所有 <TODO> 填齐（lamps.md 的 stages 现在是空表——每段至少 1 盏灯才能发布）');
console.log('  2. pnpm build-content   # 编译 + 校验');
console.log('  3. 内容齐了把 meta.md 的 status 改 active——发布闸会做 active 硬校验（C2）');
