// AI 起草整包（V0.2 C4，2026-09-21 用户拍板：从「只打标」升级为「起草 + 人工校正」）。
// 纯函数模块：prompt 组装 / 草稿校验 / LLM JSON → 编辑态。文件读写归 admin-content.ts，
// LLM 调用归路由（这里不 import llm.ts，方便单测）。
import { TOPICS, TOPICS_ZH } from '@/lib/content';
import type { AdminLamp, AdminStage } from '@/lib/admin-content';

/** LLM 草稿 JSON 里的一段 journey */
export interface DraftStage {
  id: number;
  title: string;
  goal: string;
  weeks: number;
  exercises: string[];
  do: string[];
  dont: string[];
  advance_when: string[];
  ritual: string;
  skippable?: boolean;
  free_alt?: string;
  topics?: string[];
  body: string;
}

/** LLM 草稿 JSON 里的一盏灯（label/hint 四语一次给齐） */
export interface DraftLamp {
  kind: string;
  topic: string;
  needsAction: boolean;
  promptHint: string;
  label: Record<string, string>;
  hint: Record<string, string>;
}

export interface DraftPayload {
  journey: DraftStage[];
  lamps: Record<string, DraftLamp[]>;
}

const LANGS = ['en', 'zh-CN', 'zh-TW', 'ja'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(isStr);

/** 书的 kind 前缀：第二本书不许撞 v1 的 kind（stage1_story 那批），带书前缀天然跨书唯一 */
export function kindPrefix(bookId: string): string {
  return bookId.replace(/-/g, '');
}

export const TOPIC_GLOSS = {
  'self-worth': '我不配——把自我价值与金钱、成就绑定的「不配得」感',
  parents: '和父母的关系——早年家庭塑造的金钱脚本与情感纠葛',
  'inner-turmoil': '情绪与内耗——匮乏焦虑、反刍、灾难化想象',
  boundaries: '关系与边界——碍于关系不敢谈钱、不会拒绝、过度付出',
  'money-safety': '金钱与安全感——储蓄与收入波动带来的生存恐惧和控制欲',
  allowing: '允许自己——允许享受、允许休息、允许接受好处',
} as const;

/** 四语灯文案的四语语言名（prompt 用） */
const LANG_NAME: Record<string, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  ja: '日本語',
};

// ---- prompt 组装 ----

const EXCERPT = (text: string, max: number) => (text.length > max ? text.slice(0, max) + '\n…（已截断）' : text);

function topicBlock(): string {
  return TOPICS.map((t) => `- ${t}（${TOPICS_ZH[t]}）：${TOPIC_GLOSS[t]}`).join('\n');
}

/** 起草 zh-CN journey（4 段）的 system */
export function buildJourneySystem(exemplar: string): string {
  return [
    '你是金钱关系陪伴产品的内容编辑。任务：根据一本书的素材，为它起草四段成长旅程（zh-CN）。',
    '全书 = 四段旅程：每段是一个「看见 → 松动 → 练习 → 活法」式的推进段，读者在陪伴者引导下走完一段再进下一段。',
    '',
    '六命题（topics 枚举，草稿的 topics 字段只能从这里选，每段 1-2 个）：',
    topicBlock(),
    '',
    '风格范例（v1 书《一辈子不愁钱的活法》第 1 段，学它的口吻与结构，不要抄内容）：',
    '---',
    EXCERPT(exemplar, 3000),
    '---',
    '',
    '硬性要求：',
    '- 输出 JSON，不要输出 JSON 以外的内容',
    '- 恰好 4 段，id = 1,2,3,4',
    '- 每段 body 是给读者与 AI 上下文看的心法正文，200-400 个汉字，直接对读者说话（用「你」），不用「本书」「读者」这类旁视角',
    '- goal 一句话（这一段带读者看见什么）；advance_when 2-3 条程度句式（达到什么程度算走完，判定程度不数动作）；exercises 2-3 条日常练习（每条一句话，小到今天能做）；ai_stance.do/dont 各 2-3 条（陪伴者在这段该做/不该做）；ritual 一句话（这一段的仪式，没有就写「无」）',
    '- weeks 是这一段的建议周数（数字）',
    '- skippable 固定 true；free_alt 只在涉及花钱/行动的练习时给 0 元替代版，没有就不写',
    '- 全部文字用简体中文',
  ].join('\n');
}

/** 起草 zh-CN journey 的 user（素材） */
export function buildJourneyUser(material: string, bookTitle: string, author: string): string {
  return [
    `书名：《${bookTitle}》（作者：${author || '未知'}）`,
    '素材如下（可能是书的摘录、要点整理或运营者的转述）：',
    '==========',
    EXCERPT(material, 12000),
    '==========',
    '请输出这本书的四段旅程草稿 JSON：{"stages": [...]}，每段字段：id, title, goal, weeks, exercises, do, dont, advance_when, ritual, skippable, free_alt, topics, body。',
  ].join('\n');
}

/** 起草灯表（四语文案一次给齐）的 system */
export function buildLampsSystem(exemplar: string): string {
  return [
    '你是金钱关系陪伴产品的内容编辑。任务：为一本书已起草的四段旅程设计「灯表」。',
    '灯 = 某个阶段「应达程度」的一个切面：判定的是读者到达了这个状态没有，不是他做过哪些动作。评估 LLM 拿 promptHint 当判定提示；label/hint 是用户界面文案（label=灯名，hint=未点亮时的标准说明）。',
    '',
    'topics 枚举（每盏灯挂一个）：',
    topicBlock(),
    '',
    '范例（v1 书的两盏灯，学句式，不要抄内容）：',
    '---',
    EXCERPT(exemplar, 2500),
    '---',
    '',
    '硬性要求：',
    '- 输出 JSON，不要输出 JSON 以外的内容',
    '- 第 1、2、3 段每段 2-3 盏灯；第 4 段（末段「活法」）不给灯（产品定案：末段无灯无终点线）',
    '- kind 必须以指定前缀开头（前缀 = 这本书的 id 去掉连字符），形如「前缀_stage1_xxx」，xxx 是 snake_case 短语——跨书唯一，不许模仿范例里的 kind',
    '- promptHint：中文内部备注，程度句式（「当读者……时视为到达」），给评估 LLM 看',
    '- needsAction：这盏灯是否必须有真实行为记录才能点亮（认知类 false，行动类 true；每段至多 1 盏 true）',
    '- label 与 hint 都要四语齐：' + LANGS.map((l) => `${l}=${LANG_NAME[l]}`).join('、'),
    '- label 是程度短语（如「允许过自己」不是「完成一次不配的小事」）；hint 是未点亮时的标准说明，一句话',
  ].join('\n');
}

/** 起草灯表的 user（旅程摘要 + kind 前缀） */
export function buildLampsUser(journey: DraftStage[], prefix: string): string {
  const summary = journey
    .map((s) => `段 ${s.id}「${s.title}」：${s.goal}；走完标志：${s.advance_when.join('；')}`)
    .join('\n');
  return [
    `这本书的 kind 前缀：${prefix}_`,
    '已起草的旅程：',
    summary,
    '请输出灯表 JSON：{"stages": {"1": [灯...], "2": [...], "3": []}}——键是段号字符串，第 4 段键省略或空数组。每盏灯字段：kind, topic, needsAction, promptHint, label{en,zh-CN,zh-TW,ja}, hint{en,zh-CN,zh-TW,ja}。',
  ].join('\n');
}

/** en 版 journey 翻译的 system */
export function buildEnJourneySystem(): string {
  return [
    'You are a translator for a money-relationship companion product. Translate the given zh-CN journey draft into natural, warm English.',
    '- Keep the JSON structure and field names exactly; only translate human-readable string values.',
    '- body: 150-300 words, second person ("you"), the tone of a gentle companion — not a book summary.',
    '- Do not translate enum values (topics, ids) or numbers.',
  ].join('\n');
}

// ---- 校验（镜像 build-content 的发布闸，草稿期就拦，省得发布时才发现） ----

export type DraftErrors = string[];

export function validateDraftJourney(raw: unknown): DraftErrors {
  const errors: DraftErrors = [];
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { stages?: unknown }).stages)) {
    return ['草稿缺少 stages 数组'];
  }
  const stages = (raw as { stages: unknown[] }).stages;
  const ids = stages.map((s) => (s && typeof s === 'object' ? Number((s as { id?: unknown }).id) : NaN));
  for (const need of [1, 2, 3, 4]) {
    if (!ids.includes(need)) errors.push(`缺第 ${need} 段`);
  }
  if (new Set(ids).size !== ids.length) errors.push('段 id 有重复');
  stages.forEach((s, i) => {
    const at = `stages[${i}]`;
    if (!s || typeof s !== 'object') return errors.push(`${at} 不是对象`);
    const st = s as Record<string, unknown>;
    for (const key of ['title', 'goal', 'ritual', 'body']) {
      if (!isStr(st[key])) errors.push(`${at}.${key} 缺或空`);
    }
    if (!Number.isInteger(st.weeks) || Number(st.weeks) < 1) errors.push(`${at}.weeks 必须是正整数`);
    for (const key of ['exercises', 'do', 'dont', 'advance_when']) {
      if (!isStrList(st[key])) errors.push(`${at}.${key} 必须是非空字符串数组`);
    }
    if (typeof st.body === 'string' && st.body.trim().length < 100) errors.push(`${at}.body 太短（<100 字符，发布闸要求）`);
    if (st.skippable !== undefined && typeof st.skippable !== 'boolean') errors.push(`${at}.skippable 必须是布尔`);
    if (st.free_alt !== undefined && (!isStr(st.free_alt))) errors.push(`${at}.free_alt 若提供必须是非空字符串`);
    if (st.topics !== undefined) {
      if (!isStrList(st.topics)) errors.push(`${at}.topics 若提供必须是非空数组`);
      else for (const t of st.topics) if (!(TOPICS as readonly string[]).includes(t)) errors.push(`${at}.topics 未知命题 ${t}`);
    }
  });
  return errors;
}

export function validateDraftLamps(raw: unknown, bookId: string): DraftErrors {
  const errors: DraftErrors = [];
  if (!raw || typeof raw !== 'object' || typeof (raw as { stages?: unknown }).stages !== 'object' || (raw as { stages?: unknown }).stages === null) {
    return ['灯表草稿缺少 stages 对象'];
  }
  const stages = (raw as { stages: Record<string, unknown> }).stages;
  const prefix = kindPrefix(bookId) + '_';
  let total = 0;
  for (const [stageKey, rules] of Object.entries(stages)) {
    const stage = Number(stageKey);
    if (![1, 2, 3].includes(stage)) {
      errors.push(`灯表段号 ${stageKey} 非法（只允许 1/2/3，末段第 4 段不给灯）`);
      continue;
    }
    if (!Array.isArray(rules) || rules.length === 0) continue;
    total += rules.length;
    rules.forEach((r, i) => {
      const at = `stages.${stageKey}[${i}]`;
      if (!r || typeof r !== 'object') return errors.push(`${at} 不是对象`);
      const lamp = r as Record<string, unknown>;
      if (!isStr(lamp.kind)) errors.push(`${at}.kind 缺`);
      else if (!String(lamp.kind).startsWith(prefix)) errors.push(`${at}.kind「${lamp.kind}」必须以 ${prefix} 开头（跨书唯一）`);
      if (!(TOPICS as readonly string[]).includes(String(lamp.topic))) errors.push(`${at}.topic 必须是六命题之一，得到 ${lamp.topic}`);
      if (typeof lamp.needsAction !== 'boolean') errors.push(`${at}.needsAction 必须是布尔`);
      if (!isStr(lamp.promptHint)) errors.push(`${at}.promptHint 缺`);
      for (const field of ['label', 'hint'] as const) {
        const map = (lamp[field] ?? {}) as Record<string, unknown>;
        for (const lang of LANGS) {
          if (!isStr(map[lang])) errors.push(`${at}.${field} 缺 ${lang}`);
        }
      }
    });
  }
  if (total === 0) errors.push('灯表为空（第 1-3 段每段至少 2 盏灯，否则读者推进不了）');
  return errors;
}

// ---- LLM JSON → 编辑态 ----

/** LLM journey 草稿 → 编辑态 AdminStage[]（文件名定为 <id>.md，起草总是整体替换） */
export function draftToStages(stages: DraftStage[]): AdminStage[] {
  return stages
    .filter((s) => Number.isInteger(s.id))
    .sort((a, b) => a.id - b.id)
    .map((s) => ({
      file: `${s.id}.md`,
      id: Number(s.id),
      title: String(s.title ?? ''),
      goal: String(s.goal ?? ''),
      weeks: Number(s.weeks ?? 0),
      exercises: Array.isArray(s.exercises) ? s.exercises.map(String) : [],
      do: Array.isArray(s.do) ? s.do.map(String) : [],
      dont: Array.isArray(s.dont) ? s.dont.map(String) : [],
      advance_when: Array.isArray(s.advance_when) ? s.advance_when.map(String) : [],
      ritual: String(s.ritual ?? ''),
      skippable: s.skippable !== false,
      free_alt: typeof s.free_alt === 'string' ? s.free_alt : '',
      topics: Array.isArray(s.topics) ? s.topics.map(String) : [],
      body: String(s.body ?? ''),
    }));
}

/** LLM 灯表草稿 → 编辑态 */
export function draftToLamps(stages: Record<string, DraftLamp[]>): Record<string, AdminLamp[]> {
  const out: Record<string, AdminLamp[]> = {};
  for (const [stage, rules] of Object.entries(stages)) {
    if (![1, 2, 3].includes(Number(stage)) || !Array.isArray(rules)) continue;
    out[stage] = rules.map((r) => ({
      kind: String(r.kind ?? ''),
      topic: String(r.topic ?? ''),
      needsAction: r.needsAction === true,
      promptHint: String(r.promptHint ?? ''),
      label: Object.fromEntries(LANGS.map((l) => [l, String(r.label?.[l] ?? '')])),
      hint: Object.fromEntries(LANGS.map((l) => [l, String(r.hint?.[l] ?? '')])),
    }));
  }
  return out;
}
