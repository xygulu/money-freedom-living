// 《我变了什么》变化清单（M10，docs/03 §11）：评估确认后的对照视图。
// 结构化部分（位置变化/新点亮的心印+依据/下一步）由页面直出——LLM 失败页面
// 仍有内容；本文件另负责 LLM 叙述段的生成、缓存（forConfirmedAt 变了即重
// 生成）与自过期锁。零 schema 变更：全部状态放 stage_assessment JSONB 键。

import { execWithFailover } from '@/lib/db';
import { gatherAssessMaterial, saveAssessmentState, type AssessMaterial } from '@/lib/assess';
import { LOCALE_NAME } from '@/lib/onboarding';
import type { ChangeListEntry, GrowthProfile, StageAssessment } from '@/lib/profile';

export const CHANGE_LIST_LOCK_MS = 3 * 60 * 1000; // 生成中锁自过期（LLM 45-90s + 富余）

export interface ChangeListView {
  confirmedAt: string;
  /** 上一次确认评估的位置（首评时为 null——「旅程开始」起讲） */
  previousStage: number | null;
  currentStage: number;
  /** 新点亮的心印：本次 lit，且上次（若有）未点亮 */
  newLamps: { kind: string; evidence: string }[];
  actions: string[];
  /** 与 confirmedAt 匹配的叙述段缓存（无或过期 → null） */
  narration: ChangeListEntry | null;
}

/** 从档案派生变化清单视图（页面与 API 共用；无已确认评估 → null） */
export function buildChangeListView(profile: GrowthProfile): ChangeListView | null {
  const st = profile.assessment;
  if (!st.confirmed || !st.confirmedAt) return null;
  const prevLit = new Set((st.previousConfirmed?.lamps ?? []).filter((l) => l.lit).map((l) => l.kind));
  const newLamps = st.confirmed.lamps
    .filter((l) => l.lit && l.evidence && !prevLit.has(l.kind))
    .map((l) => ({ kind: l.kind, evidence: l.evidence }));
  const narration =
    st.changeList && st.changeList.forConfirmedAt === st.confirmedAt && st.changeList.text ? st.changeList : null;
  return {
    confirmedAt: st.confirmedAt,
    previousStage: st.previousConfirmed ? st.previousConfirmed.actualStage : null,
    currentStage: st.confirmed.actualStage,
    newLamps,
    actions: st.confirmed.actions,
    narration,
  };
}

export interface ChangeListContext {
  confirmed: StageAssessment;
  previousConfirmed: StageAssessment | null;
  /** 与 buildChangeListView 一致的新灯（kind + evidence）——叙述段以它为准 */
  newLamps: { kind: string; evidence: string }[];
  earnedKinds: string[];
}

/**
 * 叙述段 prompt：把他这段时间自己的原话与做过的事拼成一张清单，让他亲眼看见
 * 变化。system 脚手架中文（内部备注），输出语言由语言钉死行控制。
 */
export function buildChangeListMessages(locale: string, material: AssessMaterial, context: ChangeListContext) {
  const lang = LOCALE_NAME[locale] ?? 'English';
  const textLen = locale === 'en' ? '100-250 words' : '150-400 字';
  const c = context.confirmed;
  const prev = context.previousConfirmed;

  const system = [
    '你是这段旅程的见证者。用户要一份《我的变化清单》——把他这段时间自己说过的话、做过的事，拼成一段他亲眼能看见变化的文字。',
    `全程用${lang}书写。`,
    '写什么（自然行文，不要标题、表格或列表符号——页面已有结构）：',
    prev
      ? `- 从上次评估到现在，他走到了哪里：上次在阶段 ${prev.actualStage}，这次在阶段 ${c.actualStage}；如果素材里有他两次面对同类场景的不同说法，可以并排放（引他原话），让变化自己浮现`
      : '- 这是他的第一份清单：从旅程开始讲起——他刚来时是什么样（画像/体检原话），现在走到了哪里',
    '- 他做过的具体的事：引用微行动、日记、信或对话摘要里的原话，至少两三件，用他自己的话',
    '- 什么在松动：对照体检画像与这段时间的言行，只说看得见的',
    '红线：',
    '- 全部用素材里的原话与事，禁止编造',
    '- 不评判、不打分、不比较：没有「进步很大/还不够/做得好」这类话；只描述，不定性',
    '- 没变化就说没变化——诚实也是陪伴；不恐吓、不许诺',
    '- 不出现任何理财建议',
    `- 长度：${textLen}，一段或两段，不分行列表`,
  ].join('\n');

  const user = [
    '## 体检画像（他说过的关于自己的话）',
    material.portrait?.spoken.length ? material.portrait.spoken.map((s) => `- 「${s}」`).join('\n') : '(无)',
    material.portrait?.script ? `- 旧脚本：${material.portrait.script}` : null,
    '',
    `## 这次确认的评估（位置：阶段 ${c.actualStage}）`,
    `它看到的你：${c.summary}`,
    c.diagnosis ? `为什么是这里：${c.diagnosis}` : null,
    c.distance ? `离「一辈子不愁钱的活法」还有多远：${c.distance}` : null,
    '新点亮的心印（依据是他的原话）：',
    context.newLamps.length > 0
      ? context.newLamps.map((l) => `- ${l.kind}：${l.evidence}`).join('\n')
      : '(这次没有新点亮的灯——就诚实说没有)',
    c.actions.length > 0 ? `他清单上的下一步：${c.actions.join('；')}` : null,
    '',
    prev
      ? [
          `## 上一次确认的评估（位置：阶段 ${prev.actualStage}）`,
          `它当时看到的你：${prev.summary}`,
          `当时点亮的灯：${prev.lamps.filter((l) => l.lit).map((l) => l.kind).join('、') || '（无）'}`,
          '',
        ].join('\n')
      : '',
    '## 已经点亮的心印',
    context.earnedKinds.length > 0 ? context.earnedKinds.map((k) => `- ${k}`).join('\n') : '(无)',
    '',
    '## 这段时间的对话摘要',
    material.memories.length > 0 ? material.memories.map((m) => `- [${m.date}] ${m.text}`).join('\n') : '(无)',
    '',
    '## 这段时间的日记',
    material.journals.length > 0 ? material.journals.map((j) => `- [${j.createdAt.slice(0, 10)}] ${j.content}`).join('\n') : '(无)',
    '',
    '## 这段时间的微行动',
    material.experiments.length > 0
      ? material.experiments.map((e) => `- [${e.date}] ${e.action}${e.feeling ? `（感受：${e.feeling}）` : ''}`).join('\n')
      : '(无)',
    '',
    '## 最近的信',
    material.letters.length > 0 ? material.letters.map((l) => `- [阶段${l.stage}] ${l.content}`).join('\n') : '(无)',
  ]
    .filter((l): l is string => l !== null)
    .join('\n');

  return { system, messages: [{ role: 'user' as const, content: user }] };
}

/** 叙述段结构边界（风格长度由 prompt 语言感知规则约束）：过短/超长判失败 */
export function validateChangeListText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text.length < 30 || text.length > 3000) return null;
  return text;
}

// ---------- stage_assessment JSONB 写入 ----------

/**
 * 组变化清单素材：复用评估素材（gatherAssessMaterial），基线=本次确认时刻——
 * 清单讲的是「确认之后到现在」发生了什么。
 */
export function gatherChangeListMaterial(userKey: string, profile: GrowthProfile) {
  return gatherAssessMaterial(userKey, profile, profile.assessment.confirmedAt!);
}

/** 生成中的非重入锁（自过期，镜像 claimAssessment；独立键不与评估锁互斥）。
 *  列非对象时同样自愈成干净对象——`||` 对非对象是追加语义（见 assess.ts 注释） */
export async function claimChangeList(userKey: string, nowISO: string): Promise<boolean> {
  const rows = await execWithFailover((sql) =>
    sql`UPDATE growth_profiles
        SET stage_assessment = CASE
              WHEN jsonb_typeof(stage_assessment) = 'object'
                THEN stage_assessment || ${JSON.stringify({ changeListLockAt: nowISO })}::jsonb
              ELSE ${JSON.stringify({ changeListLockAt: nowISO })}::jsonb
            END,
            updated_at = now()
        WHERE user_key = ${userKey}
          AND (
            jsonb_typeof(stage_assessment) <> 'object'
            OR (stage_assessment->>'changeListLockAt') IS NULL
            OR (now() - (stage_assessment->>'changeListLockAt')::timestamptz) > make_interval(secs => (${CHANGE_LIST_LOCK_MS / 1000})::double precision)
          )
        RETURNING user_key`
  );
  return rows.length > 0;
}

export async function releaseChangeListLock(userKey: string): Promise<void> {
  await saveAssessmentState(userKey, { changeListLockAt: null });
}

/** 写叙述段缓存（顺带清锁） */
export async function saveChangeList(userKey: string, entry: ChangeListEntry): Promise<void> {
  await saveAssessmentState(userKey, { changeList: entry, changeListLockAt: null });
}
