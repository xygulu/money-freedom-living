// 管理后台的内容层文件读写（V0.2 C4）。
// 与 content.ts（只读编译产物）不同：这里直接读写 content/books/<id>/ 源文件——
// 后台编辑的是源，发布（C3）才编译进 content.json。git 是天然的版本控制。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { TOPICS, type TopicId } from '@/lib/content';

export const BOOKS_DIR = join(process.cwd(), 'content', 'books');
export const TITLE_LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja'] as const;
export type TitleLocale = (typeof TITLE_LOCALES)[number];

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
  return errors;
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
  writeFileSync(join(root, bookId, 'source.md'), state.source.trimEnd() + '\n');
  for (const [locale, stages] of Object.entries(state.journey)) {
    writeStages(bookId, locale, stages, root);
  }
  writeLamps(bookId, state.lamps, root);
}
