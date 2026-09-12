// 内容层构建脚本：读取 content/ → 校验 → 生成 src/generated/content.json
// 运行：pnpm build-content（check-content 在此基础上再跑 vitest 结构断言）
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const contentDir = join(root, 'content');
const outFile = join(root, 'src/generated/content.json');

// 与 src/i18n/config.ts 保持一致（脚本不依赖 TS，硬编码并断言）
const ENABLED_LOCALES = ['en', 'zh-CN'];
const DAILY_TYPES = ['observation', 'practice', 'way'];
const STAGES = [1, 2, 3, 4];
// 与 src/lib/content.ts 的 TOPICS 保持一致（mjs 脚本无法 import TS，改一处须同步另一处）
const TOPICS = ['self-worth', 'parents', 'inner-turmoil', 'boundaries', 'money-safety', 'allowing'];
const MIN_DAILY = 90;

const errors = [];
const fail = (msg) => errors.push(msg);

function readJourney(locale) {
  const dir = join(contentDir, locale, 'journey');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((file) => {
      const raw = readFileSync(join(dir, file), 'utf8');
      const { data, content } = matter(raw);
      return { file, data, body: content.trim() };
    });
}

function validateJourney(locale, stages) {
  const byId = new Map();
  for (const { file, data, body } of stages) {
    const id = data.id;
    if (!STAGES.includes(id)) fail(`${locale}/journey/${file}: id 必须是 1-4，得到 ${id}`);
    for (const key of ['title', 'goal', 'weeks', 'exercises', 'ai_stance', 'advance_when', 'ritual']) {
      if (data[key] === undefined || data[key] === null || data[key] === '') {
        fail(`${locale}/journey/${file}: frontmatter 缺 ${key}`);
      }
    }
    if (typeof data.weeks !== 'number') fail(`${locale}/journey/${file}: weeks 必须是数字`);
    if (!Array.isArray(data.exercises) || data.exercises.length === 0) fail(`${locale}/journey/${file}: exercises 不能为空`);
    if (!Array.isArray(data.advance_when) || data.advance_when.length === 0) fail(`${locale}/journey/${file}: advance_when 不能为空`);
    if (!data.ai_stance?.do?.length || !data.ai_stance?.dont?.length) fail(`${locale}/journey/${file}: ai_stance.do/dont 不能为空`);
    if (body.length < 100) fail(`${locale}/journey/${file}: 正文太短（<100 字符），它是 AI system prompt 的原料`);
    // M10 可选字段：0 元替代版 / 可跳过 / 命题标签（枚举见 src/lib/content.ts TOPICS，六命题 docs/02 §10）
    if (data.free_alt !== undefined && (typeof data.free_alt !== 'string' || data.free_alt.trim() === ''))
      fail(`${locale}/journey/${file}: free_alt 若提供必须是非空字符串`);
    if (data.skippable !== undefined && typeof data.skippable !== 'boolean')
      fail(`${locale}/journey/${file}: skippable 必须是布尔`);
    if (data.topics !== undefined) {
      if (!Array.isArray(data.topics) || data.topics.length === 0) fail(`${locale}/journey/${file}: topics 若提供必须是非空数组`);
      else for (const t of data.topics) if (!TOPICS.includes(t)) fail(`${locale}/journey/${file}: topics 含未知命题 ${t}（允许：${TOPICS.join('/')}）`);
    }
    if (id) byId.set(id, data);
  }
  return byId;
}

function validateDaily(locale) {
  const path = join(contentDir, locale, 'daily', 'pool.json');
  let pool;
  try {
    pool = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`${locale}/daily/pool.json 不是合法 JSON: ${e.message}`);
    return [];
  }
  if (!Array.isArray(pool)) return fail(`${locale}/daily/pool.json 必须是数组`) && [];
  if (pool.length < MIN_DAILY) fail(`${locale}/daily/pool.json 只有 ${pool.length} 条，MVP 备量须 ≥${MIN_DAILY}`);

  const seen = new Set();
  pool.forEach((card, i) => {
    const at = `${locale}/daily/pool.json[${i}]`;
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

function readPractices() {
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
      return { file, date: String(data.date ?? '').slice(0, 10), type: data.type, stage: data.stage, tags: data.tags ?? [], body: content.trim() };
    });
}

// ---- safety（M4：危机词表 + 转介资源表，docs/03 §6）----
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
const journeyByLocale = {};
const dailyByLocale = {};
const safetyByLocale = {};
const journeyIds = [];

for (const locale of ENABLED_LOCALES) {
  const stages = readJourney(locale);
  const byId = validateJourney(locale, stages);
  journeyIds.push([...byId.keys()].sort());
  journeyByLocale[locale] = stages
    .map(({ file, data, body }) => ({ id: data.id, file, ...data, body }))
    .sort((a, b) => a.id - b.id);
  dailyByLocale[locale] = validateDaily(locale);
  safetyByLocale[locale] = readSafety(locale);
}

// 语言间结构对齐：journey 阶段集合一致、一签条数一致
if (journeyIds.length > 1 && !journeyIds.every((ids) => JSON.stringify(ids) === JSON.stringify(journeyIds[0]))) {
  fail(`各语言 journey 阶段集合不一致: ${JSON.stringify(journeyIds)}`);
}
const counts = ENABLED_LOCALES.map((l) => dailyByLocale[l].length);
if (new Set(counts).size > 1) fail(`各语言一签条数不一致: ${ENABLED_LOCALES.map((l, i) => `${l}=${counts[i]}`).join(', ')}`);

const generated = { journey: journeyByLocale, daily: dailyByLocale, practices: readPractices(), safety: safetyByLocale, builtAt: new Date().toISOString() };

if (errors.length) {
  console.error(`内容校验失败（${errors.length} 处）：`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}

mkdirSync(dirname(outFile), { recursive: true });
// 去掉 builtAt 的易变秒数不利于缓存——保留完整时间戳，本文件入库后 diff 可读即可
writeFileSync(outFile, JSON.stringify(generated, null, 2) + '\n');
const dailyTotal = ENABLED_LOCALES.map((l) => `${l}=${dailyByLocale[l].length}`).join(' ');
console.log(`内容校验通过 ✅ journey=${journeyByLocale[ENABLED_LOCALES[0]].length} 阶段/语言, 一签 ${dailyTotal}, practices=${generated.practices.length} 篇, safety=${Object.keys(safetyByLocale).length} 语言`);
console.log(`已生成 ${outFile}`);
