// 书目识别（V0.2 批 C4 追加二轮：输入书名自动生成的守门员，docs/02 §19）。
// 规则来自用户拍板：「输入书名自动生成所需的内容，除非 AI 找不到该书本」——
// AI 不认识这本书就拒绝生成（不硬编通用内容冒充那本书）。
// 2026-09-23 管理员确认闸：识别从「守门员」升级为「报名字」——结果（书名/作者/
// 核心主张）作为数据回给前端弹确认卡，管理员确认后才准生成；形状为此扩 title/coreMethod。
//
// 语义边界：known:false（模型明确说不认识）→ **硬拦**；
// 识别本身失败（网关抖动 / 两次 JSON 都不合法）→ **fail-open 放行**——此时后续
// 起草调用大概率也在失败，且无素材 prompt 自带「不编造原文」红线兜底；
// 放行时字段全空 + note 注明，确认卡会把 note 摆出来让管理员有意识地点确认。
import { llmCompleteJson } from './llm';

export interface BookRecognition {
  known: boolean;
  title: string; // 模型认出的这本书的全名（含副标题）；不确定就空串
  author: string;
  coreMethod: string; // 一句话核心方法/主张；不知道就空串
  note: string;
}

export function buildRecognizeSystem(): string {
  return [
    '你是书目识别器。判断你是否「真实知道」一本书——不是顺着用户的话假装知道。',
    '输出 JSON：{"known": 布尔, "title": "你认出的这本书的全名（含副标题；不确定就空串）", "author": "作者名（不知道就空串）", "coreMethod": "一句话：这本书的核心方法或主张（不知道就空串）", "note": "一句话：补充说明，或你为什么不确定"}',
    '「知道」的门槛：能给全书名、作者、核心方法/主张三者——书名听起来像某类书 ≠ 知道。',
    '不确定、没听过、疑似编造 → known:false。不要为了配合而编造书名、作者或内容概要。',
  ].join('\n');
}

export function buildRecognizeUser(titleZh: string, author: string): string {
  return [`书名：《${titleZh}》`, author ? `作者：${author}` : '作者：（未提供）', '你认识这本书吗？按 system 约定输出 JSON。'].join('\n');
}

/** 结构校验：known 必须是布尔；title/author/coreMethod/note 宽松（缺省归一空串） */
export function validateRecognition(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return ['识别输出缺少 JSON 对象'];
  if (typeof (raw as BookRecognition).known !== 'boolean') return ['known 必须是布尔'];
  return [];
}

/** 两次机会；结构仍不过（基础设施问题）→ fail-open：known:true + 字段全空 + note 注明 */
export async function recognizeBook(titleZh: string, author: string, userKey: string): Promise<BookRecognition> {
  const base = buildRecognizeUser(titleZh, author);
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llmCompleteJson<BookRecognition>({
      system: buildRecognizeSystem(),
      messages: [
        {
          role: 'user',
          content:
            attempt === 0
              ? base
              : `${base}\n\n上一次输出未通过校验：\n${lastErrors.map((e) => `- ${e}`).join('\n')}\n请修正后重新输出完整 JSON。`,
        },
      ],
      maxTokens: 400,
      callPurpose: 'admin_book_recognize',
      userKey,
    });
    if (raw === null) {
      lastErrors = ['识别输出不是合法 JSON'];
      continue;
    }
    const errors = validateRecognition(raw);
    if (errors.length === 0) {
      return {
        known: raw.known,
        title: typeof raw.title === 'string' ? raw.title.trim() : '',
        author: typeof raw.author === 'string' ? raw.author.trim() : '',
        coreMethod: typeof raw.coreMethod === 'string' ? raw.coreMethod.trim() : '',
        note: typeof raw.note === 'string' ? raw.note.trim() : '',
      };
    }
    lastErrors = errors;
  }
  return {
    known: true,
    title: '',
    author: '',
    coreMethod: '',
    note: '识别服务两次都没给出合法结果（fail-open 放行；无素材起草的「不编造原文」红线仍生效）',
  };
}
