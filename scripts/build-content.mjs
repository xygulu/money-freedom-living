// 内容层构建脚本：读取 content/ → 校验 → 生成 src/generated/content.json
// 运行：pnpm build-content（check-content 在此基础上再跑 vitest 结构断言）
// M11-B：内容层带书维度——content/books/<bookId>/{meta.md,<locale>/{journey,daily}}；safety 不分书
import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const contentDir = join(root, 'content');
const booksDir = join(contentDir, 'books');
const outFile = join(root, 'src/generated/content.json');

// 与 src/i18n/config.ts 保持一致（脚本不依赖 TS，硬编码并断言）
const ENABLED_LOCALES = ['en', 'zh-CN'];
// 书名可以先备好未转正的语言，故与 ENABLED_LOCALES 分开
const TITLE_LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja'];
const DAILY_TYPES = ['observation', 'practice', 'way'];
const STAGES = [1, 2, 3, 4];
// 与 src/lib/content.ts 的 TOPICS 保持一致（mjs 脚本无法 import TS，改一处须同步另一处）
const TOPICS = ['self-worth', 'parents', 'inner-turmoil', 'boundaries', 'money-safety', 'allowing'];
// 与 src/lib/content.ts 的 DEFAULT_BOOK_ID 保持一致（v1 单书；practices 缺 bookId 时归属它）
const DEFAULT_BOOK_ID = 'money-freedom';
const MIN_DAILY = 90;

const errors = [];
const fail = (msg) => errors.push(msg);

function listBooks() {
  if (!existsSync(booksDir)) {
    fail('content/books/ 不存在：内容层须按书组织（docs/05 §5.1）');
    return [];
  }
  return readdirSync(booksDir)
    .filter((d) => statSync(join(booksDir, d)).isDirectory())
    .sort();
}

function readBookMeta(bookId) {
  const path = join(booksDir, bookId, 'meta.md');
  if (!existsSync(path)) {
    fail(`books/${bookId}: 缺 meta.md`);
    return null;
  }
  const { data, content } = matter(readFileSync(path, 'utf8'));
  if (data.id !== bookId) fail(`books/${bookId}/meta.md: id 必须与目录名一致，得到 ${data.id}`);
  for (const key of ['author', 'source', 'status']) {
    if (!String(data[key] ?? '').trim()) fail(`books/${bookId}/meta.md: frontmatter 缺 ${key}`);
  }
  if (!['active', 'draft'].includes(data.status)) {
    fail(`books/${bookId}/meta.md: status 必须是 active|draft，得到 ${data.status}`);
  }
  const title = data.title ?? {};
  for (const locale of TITLE_LOCALES) {
    if (!String(title[locale] ?? '').trim()) fail(`books/${bookId}/meta.md: title 缺 ${locale}`);
  }
  if (!Array.isArray(data.topics) || data.topics.length === 0) {
    fail(`books/${bookId}/meta.md: topics 不能为空（这本书覆盖哪些命题）`);
  } else {
    for (const t of data.topics) if (!TOPICS.includes(t)) fail(`books/${bookId}/meta.md: 未知命题 ${t}（允许：${TOPICS.join('/')}）`);
  }
  return {
    id: bookId,
    title: Object.fromEntries(TITLE_LOCALES.map((l) => [l, String(title[l] ?? '')])),
    author: String(data.author ?? ''),
    source: String(data.source ?? ''),
    topics: Array.isArray(data.topics) ? data.topics : [],
    status: data.status,
    note: content.trim(),
  };
}

function readJourney(bookId, locale) {
  const dir = join(booksDir, bookId, locale, 'journey');
  if (!existsSync(dir)) {
    fail(`books/${bookId}/${locale}: 缺 journey/ 目录`);
    return [];
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((file) => {
      const raw = readFileSync(join(dir, file), 'utf8');
      const { data, content } = matter(raw);
      return { file, data, body: content.trim() };
    });
}

function validateJourney(bookId, locale, stages) {
  const byId = new Map();
  const at0 = `books/${bookId}/${locale}/journey`;
  for (const { file, data, body } of stages) {
    const id = data.id;
    if (!STAGES.includes(id)) fail(`${at0}/${file}: id 必须是 1-4，得到 ${id}`);
    for (const key of ['title', 'goal', 'weeks', 'exercises', 'ai_stance', 'advance_when', 'ritual']) {
      if (data[key] === undefined || data[key] === null || data[key] === '') {
        fail(`${at0}/${file}: frontmatter 缺 ${key}`);
      }
    }
    if (typeof data.weeks !== 'number') fail(`${at0}/${file}: weeks 必须是数字`);
    if (!Array.isArray(data.exercises) || data.exercises.length === 0) fail(`${at0}/${file}: exercises 不能为空`);
    if (!Array.isArray(data.advance_when) || data.advance_when.length === 0) fail(`${at0}/${file}: advance_when 不能为空`);
    if (!data.ai_stance?.do?.length || !data.ai_stance?.dont?.length) fail(`${at0}/${file}: ai_stance.do/dont 不能为空`);
    if (body.length < 100) fail(`${at0}/${file}: 正文太短（<100 字符），它是 AI system prompt 的原料`);
    // M10 可选字段：0 元替代版 / 可跳过 / 命题标签（枚举见 src/lib/content.ts TOPICS，六命题 docs/02 §10）
    if (data.free_alt !== undefined && (typeof data.free_alt !== 'string' || data.free_alt.trim() === ''))
      fail(`${at0}/${file}: free_alt 若提供必须是非空字符串`);
    if (data.skippable !== undefined && typeof data.skippable !== 'boolean')
      fail(`${at0}/${file}: skippable 必须是布尔`);
    if (data.topics !== undefined) {
      if (!Array.isArray(data.topics) || data.topics.length === 0) fail(`${at0}/${file}: topics 若提供必须是非空数组`);
      else for (const t of data.topics) if (!TOPICS.includes(t)) fail(`${at0}/${file}: topics 含未知命题 ${t}（允许：${TOPICS.join('/')}）`);
    }
    if (id) byId.set(id, data);
  }
  return byId;
}

function validateDaily(bookId, locale) {
  const path = join(booksDir, bookId, locale, 'daily', 'pool.json');
  const at0 = `books/${bookId}/${locale}/daily/pool.json`;
  let pool;
  try {
    pool = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`${at0} 不是合法 JSON: ${e.message}`);
    return [];
  }
  if (!Array.isArray(pool)) return fail(`${at0} 必须是数组`) && [];
  if (pool.length < MIN_DAILY) fail(`${at0} 只有 ${pool.length} 条，MVP 备量须 ≥${MIN_DAILY}`);

  const seen = new Set();
  pool.forEach((card, i) => {
    const at = `${at0}[${i}]`;
    if (!card.text?.trim()) fail(`${at}: text 为空`);
    if (!card.reflection?.trim()) fail(`${at}: reflection 为空`);
    if (!DAILY_TYPES.includes(card.type)) fail(`${at}: type 必须是 ${DAILY_TYPES.join('/')}，得到 ${card.type}`);
    if (!Array.isArray(card.stages) || card.stages.length === 0 || card.stages.some((s) => !STAGES.includes(s))) {
      fail(`${at}: stages 必须是 1-4 的非空数组`);
    }
    const key = card.text?.trim();
    if (key && seen.has(key)) fail(`${at}: 一签文案重复「${key}」`);
    seen.add(key);
  });
  return pool;
}

// practices 保持中文单一事实源、不分语言；frontmatter 可选 bookId（缺省归 v1 书）
function readPractices(bookIds) {
  const dir = join(contentDir, 'practices');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((file) => {
      const raw = readFileSync(join(dir, file), 'utf8');
      const { data, content } = matter(raw);
      if (!(data.date instanceof Date) && !/^\d{4}-\d{2}-\d{2}/.test(String(data.date ?? ''))) {
        fail(`practices/${file}: frontmatter 缺合法 date`);
      }
      if (!['fact', 'opinion'].includes(data.type)) fail(`practices/${file}: type 必须是 fact|opinion，得到 ${data.type}`);
      if (!STAGES.includes(data.stage)) fail(`practices/${file}: stage 必须是 1-4，得到 ${data.stage}`);
      const bookId = data.bookId ?? DEFAULT_BOOK_ID;
      if (!bookIds.includes(bookId)) fail(`practices/${file}: bookId ${bookId} 在 content/books/ 下不存在`);
      return { file, bookId, date: String(data.date ?? '').slice(0, 10), type: data.type, stage: data.stage, tags: data.tags ?? [], body: content.trim() };
    });
}

// ---- safety（M4：危机词表 + 转介资源表，docs/03 §6）----
// 安全网不分书：任何一本书里说出那句话，接住的方式都一样。
// 词表是"召回优先"的粗筛网：宁可宽，误报由 LLM 语义确认兜住；漏检才是事故。
function readSafety(locale) {
  const read = (sub) => JSON.parse(readFileSync(join(contentDir, 'safety', sub, `${locale}.json`), 'utf8'));
  const keywords = read('keywords');
  const resources = read('resources');
  for (const kind of ['crisis', 'domesticViolence']) {
    const list = keywords[kind];
    if (!Array.isArray(list) || list.length < (kind === 'crisis' ? 8 : 5)) {
      fail(`safety/keywords/${locale}.json: ${kind} 词表过短（召回优先，crisis ≥8 条、domesticViolence ≥5 条）`);
    }
    const entries = resources[kind];
    if (!Array.isArray(entries) || entries.length === 0) {
      fail(`safety/resources/${locale}.json: ${kind} 转介资源不能为空`);
    } else {
      entries.forEach((r, i) => {
        if (!r.name?.trim() || !r.contact?.trim()) fail(`safety/resources/${locale}.json: ${kind}[${i}] 缺 name/contact`);
      });
    }
  }
  if (!resources.verifyNote?.trim()) fail(`safety/resources/${locale}.json: 缺 verifyNote（上线前逐条核实的提醒）`);
  return { keywords, resources };
}

// ---- 构建 ----
const bookIds = listBooks();
if (!bookIds.includes(DEFAULT_BOOK_ID)) fail(`content/books/ 下缺默认书 ${DEFAULT_BOOK_ID}`);

const books = [];
const journeyByBook = {};
const dailyByBook = {};

for (const bookId of bookIds) {
  const meta = readBookMeta(bookId);
  if (meta) books.push(meta);
  journeyByBook[bookId] = {};
  dailyByBook[bookId] = {};
  const journeyIds = [];
  for (const locale of ENABLED_LOCALES) {
    const stages = readJourney(bookId, locale);
    const byId = validateJourney(bookId, locale, stages);
    journeyIds.push([...byId.keys()].sort());
    journeyByBook[bookId][locale] = stages
      .map(({ file, data, body }) => ({ id: data.id, file, ...data, body }))
      .sort((a, b) => a.id - b.id);
    dailyByBook[bookId][locale] = validateDaily(bookId, locale);
  }
  // 语言间结构对齐（同一本书内）：journey 阶段集合一致、一签条数一致
  if (journeyIds.length > 1 && !journeyIds.every((ids) => JSON.stringify(ids) === JSON.stringify(journeyIds[0]))) {
    fail(`books/${bookId}: 各语言 journey 阶段集合不一致: ${JSON.stringify(journeyIds)}`);
  }
  const counts = ENABLED_LOCALES.map((l) => dailyByBook[bookId][l].length);
  if (new Set(counts).size > 1) {
    fail(`books/${bookId}: 各语言一签条数不一致: ${ENABLED_LOCALES.map((l, i) => `${l}=${counts[i]}`).join(', ')}`);
  }
}

const safetyByLocale = {};
for (const locale of ENABLED_LOCALES) safetyByLocale[locale] = readSafety(locale);

const generated = {
  books,
  journey: journeyByBook,
  daily: dailyByBook,
  practices: readPractices(bookIds),
  safety: safetyByLocale,
  builtAt: new Date().toISOString(),
};

if (errors.length) {
  console.error(`内容校验失败（${errors.length} 处）：`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}

mkdirSync(dirname(outFile), { recursive: true });
// 去掉 builtAt 的易变秒数不利于缓存——保留完整时间戳，本文件入库后 diff 可读即可
writeFileSync(outFile, JSON.stringify(generated, null, 2) + '\n');
const summary = books
  .map((b) => `${b.id}(${b.status}, journey=${journeyByBook[b.id][ENABLED_LOCALES[0]].length}, 一签 ${ENABLED_LOCALES.map((l) => `${l}=${dailyByBook[b.id][l].length}`).join(' ')})`)
  .join(' | ');
console.log(`内容校验通过 ✅ ${books.length} 本书：${summary}`);
console.log(`practices=${generated.practices.length} 篇, safety=${Object.keys(safetyByLocale).length} 语言`);
console.log(`已生成 ${outFile}`);
