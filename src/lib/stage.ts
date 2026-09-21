// 阶段进度（M9 需求③，语义修正版）：进度评估的是用户当前表现出的认知与行为
// 实际所处的阶段——离核心价值「一辈子不愁钱的活法」已达成的进度——与产品内
// 操作/交互次数没有严格关系。灯的点亮由阶段评估判定（assess.ts，AI 提议 + 用户
// 确认），展示真值是 assessment.confirmed.lamps——最近一次确认评估的结论；stamps
// 只是确认仪式同步留下的心印存档（足迹/心印陈列用），不是灯的判定来源。本文件
// 只负责灯的形状与展示判定。只增不减：灯不熄灭、阶段不倒退；无 deadline、无
// 红点；阶段 4 没有终点线。
import type { GrowthProfile, Stamp, ThreadDepth } from '@/lib/profile';
import {
  DEFAULT_BOOK_ID,
  getBookLamps,
  localizedText,
  stageCountFor,
  type LampRuleData,
  type TopicId,
} from '@/lib/content';

export interface StageCheck {
  kind: Stamp['kind']; // 关联评估结论与确认时入档的心印 kind
  /** 「这盏灯是什么」——服务端按 locale 从书的灯表解析好（V0.2 B4：灯名属于书，不再走 i18n labelKey） */
  label: string;
  /** 未点亮时展示的「标准」（内容层四语，随书替换；没有则空串） */
  hint: string;
  done: boolean;
  /** 这盏灯要真实行为记录才点得亮（见 LampRule.needsAction）——未亮时据此提示去记录 */
  needsAction: boolean;
  /**
   * 这盏灯落在哪条命题线上（M11-D 命题灯图）。呈现层据此告诉用户「这盏灯是哪件事」——
   * 灯的形状属于这本书，命题属于他自己；换书时灯位会变，这条线上的程度不会退（docs/05 §3.2）。
   */
  topic: TopicId;
  /** 他在这条命题线上已经走到的程度（跨书累加，与本书灯亮不亮各说各的；无记录为 null） */
  threadDepth: ThreadDepth | null;
}

export interface StageProgress {
  checks: StageCheck[];
  litCount: number;
}

// 灯图顶点布局在 ./lamp-geometry（叶子模块）——StageLampChart（客户端组件）
// 不能经由本文件连坐 content.ts 的 node:fs（见该文件头注）；这里 re-export
// 保持测试侧既有 import 不动。
export { lampChartPoints } from './lamp-geometry';

/**
 * 一盏灯的判定规则（V0.2 B4 起：形状与文案属于书，来源 content/books/<id>/lamps.md，
 * 经 build-content 校验后进内容装载）。kind 收紧为心印身份的联合类型；
 * label/hint 四语在内容层（U6：书的语汇不得留在产品层 i18n）。
 */
export type LampRule = Omit<LampRuleData, 'kind'> & { kind: Stamp['kind'] };

/**
 * 取这本书的灯表，认不出就**显式报错**。此前未知 bookId 静默回落第一本书——
 * 拿别的书的标准判人是事故（第二本书的灯会画成第一本的），宁可当场炸出来
 * （docs/02 §20.7 红线 6）。
 */
function requireBookLamps(bookId: string): Record<number, LampRule[]> {
  const table = getBookLamps(bookId);
  if (!table) {
    throw new Error(
      `[stage] 未知 bookId "${bookId}"：内容层没有这本书的灯表（content/books/<id>/lamps.md）。` +
        '宁可显式报错也不静默回落第一本书——拿别的书的标准判人是事故（docs/02 §20.7 红线 6）。',
    );
  }
  return table as Record<number, LampRule[]>;
}

/**
 * 这本书这个段的灯。灯判定表整体在内容层（lamps.md）：每盏灯是本阶段应达程度的
 * 一个切面——判定的是状态到达了没有，不是做过哪些动作（言行只是证据）。判定发生
 * 在评估里（依据素材 + 用户确认），代码里只负责读取。promptHint 与 journey 的
 * advance_when 一同喂给评估 LLM，一律程度句式书写。
 */
export function lampsFor(bookId: string, stage: number): LampRule[] {
  return requireBookLamps(bookId)[stage] ?? [];
}

/**
 * 灯亮之后落在命题线上的程度（docs/05 §4.6）：
 * 认知类的灯亮 = 在这条命题上"看见了"；行为类的灯亮 = 旧做法真的被替换过一次；
 * 本阶段灯全亮（随之开启下一段）= 这条命题在这本书里走完了。只增不减由 mergeDepth 兜住。
 */
export function lampDepth(rule: LampRule, stageAllLit: boolean): ThreadDepth {
  if (stageAllLit) return 'mastered';
  return rule.needsAction ? 'replaced' : 'seen';
}

/** 本阶段里「必须有真实行为记录才允许点亮」的灯 kind（评估 prompt 与硬闸共用）。 */
export function actionEvidenceKinds(stage: number, bookId: string = DEFAULT_BOOK_ID): string[] {
  return lampsFor(bookId, stage).filter((r) => r.needsAction).map((r) => r.kind);
}

/** v1 那本书的段数。**新代码别再直接用它**——段数属于书，用 stageCountFor(bookId)。
 *  留着是因为「阶段 4 没有终点线」这类 v1 文案与判定仍按它写（docs/02 §4）。 */
export const MAX_STAGE = 4;

/** 灯的点亮判定 = 最近一次确认的评估里这盏灯亮不亮（评估结论，不是动作记录）。
 *  评估没说亮的灯，即使 stamps 里有历史存档印也不亮。最后一段无灯。
 *  每盏灯同时带出它所在的命题线、该线上的跨书程度与按 locale 解析好的灯名/标准——
 *  灯属书、命题属人（docs/05 §3.2）。bookId 缺省 = v1 的书：存量调用点不传也跟以前一模一样。 */
export function computeStageProgress(
  locale: string,
  stage: number,
  profile: GrowthProfile,
  bookId: string = DEFAULT_BOOK_ID
): StageProgress {
  const verdict = new Map((profile.assessment.confirmed?.lamps ?? []).map((l) => [l.kind, l.lit]));
  const checks: StageCheck[] = lampsFor(bookId, stage).map((r) => ({
    kind: r.kind,
    label: localizedText(r.label, locale, r.kind),
    hint: localizedText(r.hint, locale, ''),
    done: verdict.get(r.kind) === true,
    needsAction: r.needsAction,
    topic: r.topic,
    threadDepth: profile.threads[r.topic]?.depth ?? null,
  }));
  return { checks, litCount: checks.filter((c) => c.done).length };
}

/** 分段刻度（全局进度条用）：走过的段整段填充（阶段推进只发生在评估确认仪式
 *  里，「走过」本身就是评估结论）；当前段按最近一次确认评估点亮的灯数；未到的
 *  段全空——没有评估过的进度不造假。没有灯的那一段 total=0（无灯无刻度）。
 *  画几格按这本书分几段来——第二本可以是三段或五段，进度栏不该永远画四格。
 *  未知 bookId 在 requireBookLamps 处显式报错，不再回落 v1 段数。 */
export function stageLampScales(
  profile: GrowthProfile,
  bookId: string = DEFAULT_BOOK_ID
): { id: number; lit: number; total: number }[] {
  requireBookLamps(bookId);
  const verdict = new Map((profile.assessment.confirmed?.lamps ?? []).map((l) => [l.kind, l.lit]));
  const count = stageCountFor(bookId);
  return Array.from({ length: count }, (_, i) => i + 1).map((id) => {
    const rules = lampsFor(bookId, id);
    const lit =
      id < profile.stage
        ? rules.length
        : id === profile.stage
          ? rules.filter((r) => verdict.get(r.kind) === true).length
          : 0;
    return { id, lit, total: rules.length };
  });
}

/** 程度制联动：确认评估里本阶段灯全亮 = 本阶段应达程度全达成 → 下一阶段随之
 *  开启（不由素材/动作门槛决定，也不需要单独的推进动作）。返回应推进到的阶段
 *  号；无需推进返回 null。纯函数，getProfile 落库自愈与 confirm 收口共用同一判定。
 *  未知 bookId 显式报错（先于段数判断，不许静默返回 null 假装「无需推进」）。 */
export function stageAdvanceTarget(profile: GrowthProfile, bookId: string = DEFAULT_BOOK_ID): number | null {
  requireBookLamps(bookId);
  const stage = profile.stage;
  if (stage >= stageCountFor(bookId)) return null;
  const rules = lampsFor(bookId, stage);
  if (rules.length === 0) return null;
  const lit = new Set((profile.assessment.confirmed?.lamps ?? []).filter((l) => l.lit).map((l) => l.kind));
  return rules.every((r) => lit.has(r.kind)) ? stage + 1 : null;
}
