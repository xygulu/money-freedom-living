// 管理后台的内容层文件读写（V0.2 C4）。
// 与 content.ts（只读编译产物）不同：这里直接读写 content/books/<id>/ 源文件——
// 后台编辑的是源，发布（C3）才编译进 content.json。git 是天然的版本控制。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { TOPICS, type TopicId } from '@/lib/content';

export const BOOKS_DIR = join(process.cwd(), 'content', 'books');
export const PRACTICES_DIR = join(process.cwd(), 'content', 'practices');
export const TITLE_LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja'] as const;
export type TitleLocale = (typeof TITLE_LOCALES)[number];
/** 池子只有这两语（zh-TW/ja 内容层暂缓，docs/02 §13.3 转正前置另议） */
export const DAILY_LOCALES = ['zh-CN', 'en'] as const;

/** 后台书列表行（/admin 首页的选书清单） */
export interface AdminBookRow {
  id: string;
  status: string;
  title: string;
  stageCount: number;
  lampCount: number;
  dailyCount: number;
}

/** 一个段的编辑态（源文件 frontmatter + 正文；file 是写回目标文件名）。
 *  skippable 三态：null = 源文件里没有这个键（写回时保持不写——v1 第 2 段就没有）。 */
export interface AdminStage {
  file: string;
  id: number;
  title: string;
  goal: string;
  weeks: number;
  exercises: string[];
  do: string[];
  dont: string[];
  advance_when: string[];
  ritual: string;
  skippable: boolean | null;
  free_alt: string;
  topics: string[];
  body: string;
}

/** 一盏灯的编辑态（与 LampRuleData 同构，label/hint 四语） */
export interface AdminLamp {
  kind: string;
  topic: string;
  needsAction: boolean;
  promptHint: string;
  label: Record<string, string>;
  hint: Record<string, string>;
}

/** 一条一签的编辑态（与 DailyCard 同构 + topics；池子只有 zh-CN/en 两语） */
export interface AdminDailyCard {
  text: string;
  type: string;
  stages: number[];
  reflection: string;
  topics: string[];
}

/** 一篇创造者笔记的编辑态（content/practices/，书外、中文单一事实源） */
export interface AdminPracticeNote {
  file: string;
  date: string;
  type: string;
  stage: number;
  tags: string[];
  topics: string[];
  body: string;
}

/** 书工作台的全量编辑态（保存接口的原样往返单位） */
export interface AdminBookState {
  meta: {
    id: string;
    title: Record<string, string>;
    author: string;
    source: string;
    topics: string[];
    status: 'draft' | 'active';
    note: string;
  };
  source: string;
  journey: Record<string, AdminStage[]>;
  lamps: Record<string, AdminLamp[]>;
  daily: Record<'zh-CN' | 'en', AdminDailyCard[]>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function readMeta(bookId: string, root: string): AdminBookState['meta'] | null {
  const path = join(root, bookId, 'meta.md');
  if (!existsSync(path)) return null;
  const { data, content } = matter(readFileSync(path, 'utf8'));
  const title = (data.title ?? {}) as Record<string, unknown>;
  return {
    id: String(data.id ?? bookId),
    title: Object.fromEntries(TITLE_LOCALES.map((l) => [l, str(title[l])])),
    author: str(data.author),
    source: str(data.source),
    topics: strList(data.topics).filter((t): t is TopicId => (TOPICS as readonly string[]).includes(t)),
    status: data.status === 'active' ? 'active' : 'draft',
    note: content.trim(),
  };
}

/** /admin 首页的书清单：源文件直读（含还没发布的 draft 书——content.json 里没有它们） */
export function listAdminBooks(root: string = BOOKS_DIR): AdminBookRow[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => !d.startsWith('.') && existsSync(join(root, d, 'meta.md')))
    .sort()
    .map((id) => {
      const meta = readMeta(id, root);
      let stageCount = 0;
      const journeyDir = join(root, id, 'zh-CN', 'journey');
      if (existsSync(journeyDir)) {
        stageCount = readdirSync(journeyDir).filter((f) => f.endsWith('.md')).length;
      }
      let lampCount = 0;
      const lampsPath = join(root, id, 'lamps.md');
      if (existsSync(lampsPath)) {
        const { data } = matter(readFileSync(lampsPath, 'utf8'));
        for (const rules of Object.values((data.stages ?? {}) as Record<string, unknown>)) {
          if (Array.isArray(rules)) lampCount += rules.length;
        }
      }
      let dailyCount = 0;
      const poolPath = join(root, id, 'zh-CN', 'daily', 'pool.json');
      if (existsSync(poolPath)) {
        try {
          const pool: unknown = JSON.parse(readFileSync(poolPath, 'utf8'));
          if (Array.isArray(pool)) dailyCount = pool.length;
        } catch {
          /* 坏池子按 0 显示，发布闸会拦 */
        }
      }
      return {
        id,
        status: meta?.status ?? '?',
        title: meta?.title['zh-CN']?.trim() || meta?.title.en?.trim() || id,
        stageCount,
        lampCount,
        dailyCount,
      };
    });
}

function readStages(bookId: string, locale: string, root: string): AdminStage[] {
  const dir = join(root, bookId, locale, 'journey');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => {
      const { data, content } = matter(readFileSync(join(dir, file), 'utf8'));
      const stance = (data.ai_stance ?? {}) as Record<string, unknown>;
      return {
        file,
        id: Number(data.id ?? 0),
        title: str(data.title),
        goal: str(data.goal),
        weeks: typeof data.weeks === 'number' ? data.weeks : 0,
        exercises: strList(data.exercises),
        do: strList(stance.do),
        dont: strList(stance.dont),
        advance_when: strList(data.advance_when),
        ritual: str(data.ritual),
        skippable: data.skippable === undefined ? null : data.skippable === true,
        free_alt: str(data.free_alt),
        topics: strList(data.topics),
        body: content.trim(),
      };
    })
    .sort((a, b) => a.id - b.id);
}

function readLamps(bookId: string, root: string): Record<string, AdminLamp[]> {
  const path = join(root, bookId, 'lamps.md');
  if (!existsSync(path)) return {};
  const { data } = matter(readFileSync(path, 'utf8'));
  const out: Record<string, AdminLamp[]> = {};
  for (const [stage, rules] of Object.entries((data.stages ?? {}) as Record<string, unknown>)) {
    if (!Array.isArray(rules)) continue;
    out[stage] = rules.map((r) => {
      const lamp = (r ?? {}) as Record<string, unknown>;
      const label = (lamp.label ?? {}) as Record<string, unknown>;
      const hint = (lamp.hint ?? {}) as Record<string, unknown>;
      return {
        kind: str(lamp.kind),
        topic: str(lamp.topic),
        needsAction: lamp.needsAction === true,
        promptHint: str(lamp.promptHint),
        label: Object.fromEntries(TITLE_LOCALES.map((l) => [l, str(label[l])])),
        hint: Object.fromEntries(TITLE_LOCALES.map((l) => [l, str(hint[l])])),
      };
    });
  }
  return out;
}

function readDaily(bookId: string, locale: 'zh-CN' | 'en', root: string): AdminDailyCard[] {
  const path = join(root, bookId, locale, 'daily', 'pool.json');
  if (!existsSync(path)) return [];
  try {
    const pool: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(pool)) return [];
    return pool.map((c) => {
      const card = (c ?? {}) as Record<string, unknown>;
      return {
        text: str(card.text),
        type: str(card.type),
        stages: Array.isArray(card.stages) ? card.stages.map(Number) : [],
        reflection: str(card.reflection),
        topics: strList(card.topics),
      };
    });
  } catch {
    return []; // 坏池子按空展示（计数 0），发布闸会拦
  }
}

/** 创造者笔记（content/practices/，书外共享；README.md 不是笔记） */
export function readPracticeNotes(root: string = PRACTICES_DIR): AdminPracticeNote[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
    .map((file) => {
      const { data, content } = matter(readFileSync(join(root, file), 'utf8'));
      return {
        file,
        date: String(data.date ?? '').slice(0, 10),
        type: str(data.type),
        stage: typeof data.stage === 'number' ? data.stage : 0,
        tags: strList(data.tags),
        topics: strList(data.topics),
        body: content.trim(),
      };
    });
}

/** 给一篇笔记补/改 topics：字符串手术只动 frontmatter 里的 topics 行，其余字节原样
 *  （gray-matter 重序列化会把 date 变 Date→ISO 串等副作用，不走）。 */
export function writePracticeTopics(file: string, topics: string[], root: string = PRACTICES_DIR): void {
  const path = join(root, file);
  if (!existsSync(path)) throw new Error(`笔记不存在：${file}`);
  const raw = readFileSync(path, 'utf8');
  const end = raw.indexOf('\n---', 3); // frontmatter 结束（首个 --- 在 0）
  if (end < 0) throw new Error(`笔记缺 frontmatter：${file}`);
  const fm = raw.slice(0, end);
  const rest = raw.slice(end);
  const line = `topics: [${topics.join(', ')}]`;
  const next = /^topics:.*$/m.test(fm) ? fm.replace(/^topics:.*$/m, line) : `${fm}\n${line}`;
  writeFileSync(path, next + rest);
}

/** 书工作台数据（编辑器的初始态）。书不存在返回 null。 */
export function readAdminBook(bookId: string, root: string = BOOKS_DIR): AdminBookState | null {
  const meta = readMeta(bookId, root);
  if (!meta) return null;
  const sourcePath = join(root, bookId, 'source.md');
  return {
    meta,
    source: existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8').trim() : '',
    journey: {
      'zh-CN': readStages(bookId, 'zh-CN', root),
      en: readStages(bookId, 'en', root),
    },
    lamps: readLamps(bookId, root),
    daily: {
      'zh-CN': readDaily(bookId, 'zh-CN', root),
      en: readDaily(bookId, 'en', root),
    },
  };
}

const yamlList = (items: string[]) => items.filter((s) => s.trim());

function stageFrontmatter(s: AdminStage): Record<string, unknown> {
  const data: Record<string, unknown> = {
    id: s.id,
    title: s.title,
    goal: s.goal,
    weeks: s.weeks,
    exercises: yamlList(s.exercises),
    ai_stance: { do: yamlList(s.do), dont: yamlList(s.dont) },
    advance_when: yamlList(s.advance_when),
    ritual: s.ritual,
  };
  if (s.skippable !== null) data.skippable = s.skippable === true;
  if (s.free_alt.trim()) data.free_alt = s.free_alt.trim();
  if (s.topics.length > 0) data.topics = s.topics;
  return data;
}

function writeStages(bookId: string, locale: string, stages: AdminStage[], root: string): void {
  const dir = join(root, bookId, locale, 'journey');
  mkdirSync(dir, { recursive: true });
  // 清掉旧文件再写：段 id 以 frontmatter 为准，同名不同 id 会产出重复段
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.md')) rmSync(join(dir, f));
  }
  for (const s of stages) {
    const name = s.file.trim().endsWith('.md') ? s.file.trim() : `${s.id}.md`;
    writeFileSync(join(dir, name), matter.stringify(s.body.trim() + '\n', stageFrontmatter(s)));
  }
}

function writeLamps(bookId: string, lamps: Record<string, AdminLamp[]>, root: string): void {
  const stages: Record<string, unknown> = {};
  for (const [stage, rules] of Object.entries(lamps)) {
    stages[stage] = rules.map((r) => ({
      kind: r.kind,
      topic: r.topic,
      needsAction: r.needsAction === true,
      promptHint: r.promptHint,
      label: Object.fromEntries(TITLE_LOCALES.map((l) => [l, r.label[l] ?? ''])),
      hint: Object.fromEntries(TITLE_LOCALES.map((l) => [l, r.hint[l] ?? ''])),
    }));
  }
  const dir = join(root, bookId);
  mkdirSync(dir, { recursive: true });
  // 正文区的说明注释原样保留（frontmatter 必须顶格，注释只能住在正文里；build-content 只读 frontmatter）；
  // 文件尚无正文（如 AI 起草新建）才写标准说明
  const path = join(dir, 'lamps.md');
  let body = '';
  if (existsSync(path)) body = matter(readFileSync(path, 'utf8')).content.trim();
  if (!body) {
    body = [
      '<!-- 灯表：字段语义见 content/books/money-freedom/lamps.md 头注。',
      '     kind 跨书唯一（起草稿带书前缀）；topic ∈ 六命题；label/hint 四语非空；promptHint 是给评估 LLM 的内部备注。-->',
    ].join('\n');
  }
  writeFileSync(path, matter.stringify(body + '\n', { stages }));
}

/** 保存前的形状校验：只拦「会把源文件写坏」的结构垃圾（内容质量由发布闸管） */
export function validateSaveShape(state: unknown): string[] {
  const errors: string[] = [];
  if (!state || typeof state !== 'object') return ['state 不是对象'];
  const s = state as Partial<AdminBookState>;
  if (!s.meta || typeof s.meta !== 'object') return ['缺 meta'];
  if (s.meta.status !== 'draft' && s.meta.status !== 'active') errors.push('meta.status 必须是 draft|active');
  if (!Array.isArray(s.meta.topics)) errors.push('meta.topics 必须是数组');
  for (const t of s.meta.topics ?? []) {
    if (!(TOPICS as readonly string[]).includes(t)) errors.push(`meta.topics 未知命题 ${t}`);
  }
  if (typeof s.source !== 'string') errors.push('source 必须是字符串');
  if (!s.journey || typeof s.journey !== 'object') errors.push('缺 journey');
  for (const [locale, stages] of Object.entries(s.journey ?? {})) {
    if (!Array.isArray(stages)) {
      errors.push(`journey.${locale} 必须是数组`);
      continue;
    }
    const ids = new Set<number>();
    for (const [i, st] of stages.entries()) {
      const at = `journey.${locale}[${i}]`;
      if (!st || typeof st !== 'object') {
        errors.push(`${at} 不是对象`);
        continue;
      }
      if (!Number.isInteger(st.id) || Number(st.id) < 1) errors.push(`${at}.id 必须是正整数`);
      else if (ids.has(Number(st.id))) errors.push(`${at}.id ${st.id} 重复`);
      else ids.add(Number(st.id));
      if (typeof st.body !== 'string') errors.push(`${at}.body 必须是字符串`);
    }
  }
  if (!s.lamps || typeof s.lamps !== 'object') errors.push('缺 lamps');
  for (const [stage, rules] of Object.entries(s.lamps ?? {})) {
    if (!/^\d+$/.test(stage)) errors.push(`lamps 段号 ${stage} 必须是数字`);
    if (!Array.isArray(rules)) {
      errors.push(`lamps.${stage} 必须是数组`);
      continue;
    }
    for (const [i, lamp] of rules.entries()) {
      if (!lamp || typeof lamp !== 'object' || !String((lamp as AdminLamp).kind ?? '').trim()) {
        errors.push(`lamps.${stage}[${i}].kind 缺`);
      }
    }
  }
  if (!s.daily || typeof s.daily !== 'object') errors.push('缺 daily');
  for (const locale of DAILY_LOCALES) {
    const pool = s.daily?.[locale];
    if (!Array.isArray(pool)) {
      errors.push(`daily.${locale} 必须是数组`);
      continue;
    }
    for (const [i, card] of pool.entries()) {
      const at = `daily.${locale}[${i}]`;
      if (!card || typeof card !== 'object') {
        errors.push(`${at} 不是对象`);
        continue;
      }
      if (typeof card.text !== 'string') errors.push(`${at}.text 必须是字符串`);
      if (typeof card.reflection !== 'string') errors.push(`${at}.reflection 必须是字符串`);
      if (!['observation', 'practice', 'way'].includes(String(card.type))) errors.push(`${at}.type 必须是 observation|practice|way`);
      if (!Array.isArray(card.stages) || !card.stages.every((n) => Number.isInteger(n) && n >= 1 && n <= 4)) {
        errors.push(`${at}.stages 必须是 1-4 的数字数组`);
      }
      for (const t of Array.isArray(card.topics) ? card.topics : ['(非数组)']) {
        if (!(TOPICS as readonly string[]).includes(t)) errors.push(`${at}.topics 未知命题 ${String(t)}`);
      }
    }
  }
  return errors;
}

/** pool.json 保持「每条一行内联 JSON、2 空格缩进」的既有格式（diff 干净） */
function writeDaily(bookId: string, locale: 'zh-CN' | 'en', pool: AdminDailyCard[], root: string): void {
  const dir = join(root, bookId, locale, 'daily');
  mkdirSync(dir, { recursive: true });
  const body = pool.length === 0 ? '[]' : '[\n' + pool.map((c) => '  ' + JSON.stringify(c)).join(',\n') + '\n]';
  writeFileSync(join(dir, 'pool.json'), body + '\n');
}

/** 保存工作台：整份状态写回源文件（后台是单人工具，粗粒度整存）。书不存在抛错。 */
export function writeAdminBook(bookId: string, state: AdminBookState, root: string = BOOKS_DIR): void {
  if (!existsSync(join(root, bookId, 'meta.md'))) throw new Error(`书不存在：${bookId}`);
  const meta = state.meta;
  writeFileSync(
    join(root, bookId, 'meta.md'),
    matter.stringify(meta.note.trim() + '\n', {
      id: bookId, // id 以目录名为准，不信任表单值
      title: Object.fromEntries(TITLE_LOCALES.map((l) => [l, meta.title[l] ?? ''])),
      author: meta.author,
      source: meta.source,
      topics: meta.topics,
      status: meta.status === 'active' ? 'active' : 'draft',
    }),
  );
  // 素材保真：原本没有 source.md 且素材为空 → 不凭空造文件（v1 就没有这个文件）
  const sourcePath = join(root, bookId, 'source.md');
  if (state.source.trim() || existsSync(sourcePath)) {
    writeFileSync(sourcePath, state.source.trimEnd() + '\n');
  }
  for (const [locale, stages] of Object.entries(state.journey)) {
    writeStages(bookId, locale, stages, root);
  }
  writeLamps(bookId, state.lamps, root);
  for (const locale of DAILY_LOCALES) writeDaily(bookId, locale, state.daily[locale] ?? [], root);
}
