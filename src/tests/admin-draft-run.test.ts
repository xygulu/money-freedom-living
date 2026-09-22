// 起草执行体测试（runDraftStep）：守卫/识别闸/分批一签/journey 链/写盘。
// llmCompleteJson 与 recognizeBook 用 mock；书骨架落在真实临时目录（writeAdminBook 同款）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAdminBook, writeAdminBook } from '@/lib/admin-content';
import { createBookSkeleton } from '@/lib/admin-scaffold';
import { runDraftStep } from '@/lib/admin-draft-run';
import { llmCompleteJson } from '@/lib/llm';
import { recognizeBook } from '@/lib/admin-recognize';

vi.mock('@/lib/llm', () => ({ llmCompleteJson: vi.fn() }));
vi.mock('@/lib/admin-recognize', () => ({ recognizeBook: vi.fn() }));

const llmMock = vi.mocked(llmCompleteJson);
const recMock = vi.mocked(recognizeBook);

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mfl-draftrun-'));
  llmMock.mockReset();
  recMock.mockReset();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeBook(bookId = 'test-book'): void {
  createBookSkeleton({ bookId, titleZh: '测试之书', author: '某人' }, root);
}

/** 合法一签：type 三型轮转、stages 四段轮转（合并后能过全量校验） */
function card(i: number) {
  return {
    text: `签文第 ${i} 号`,
    type: (['observation', 'practice', 'way'] as const)[i % 3],
    stages: [(i % 4) + 1],
    reflection: `此刻什么感受 ${i}？`,
    topics: ['self-worth'],
  };
}

const stage = (id: number) => ({
  id,
  title: `段${id}`,
  goal: '这一段带读者看见什么',
  weeks: 3,
  exercises: ['每天记一件小事'],
  do: ['承接'],
  dont: ['说教'],
  advance_when: ['能说出自己的旧脚本'],
  ritual: '无',
  skippable: true,
  body: '正文'.repeat(60),
});

const lamp = (kind: string) => ({
  kind,
  topic: 'self-worth',
  needsAction: false,
  promptHint: '当读者能认出旧脚本时视为到达',
  label: { en: 'Seen', 'zh-CN': '看见', 'zh-TW': '看見', ja: '見えた' },
  hint: { en: 'not yet', 'zh-CN': '还没到', 'zh-TW': '還沒到', ja: 'まだ見えていない' },
});

describe('守卫与识别闸', () => {
  it('书不存在 → book_not_found', async () => {
    const r = await runDraftStep('ghost', 'daily', '', 'a@b.c', undefined, root);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('book_not_found');
  });

  it('active 书拒绝起草（AI 不覆盖线上内容），日志带改回 draft 的指引', async () => {
    makeBook();
    const state = readAdminBook('test-book', root)!;
    writeAdminBook('test-book', { ...state, meta: { ...state.meta, status: 'active' } }, root);
    const r = await runDraftStep('test-book', 'daily', 'x'.repeat(80), 'a@b.c', undefined, root);
    expect(r.error).toBe('book_is_active');
    expect(r.log.join('\n')).toContain('改回 draft');
    expect(llmMock).not.toHaveBeenCalled();
  });

  it('无素材 + AI 不认识 → book_unknown，日志给两条路；不进生成', async () => {
    makeBook();
    recMock.mockResolvedValueOnce({ known: false, title: '', author: '', coreMethod: '', note: '没听过这本书' });
    const r = await runDraftStep('test-book', 'daily', '', 'a@b.c', undefined, root);
    expect(r.error).toBe('book_unknown');
    expect(r.log.join('\n')).toContain('AI 不认识《测试之书》');
    expect(r.log.join('\n')).toContain('素材框');
    expect(llmMock).not.toHaveBeenCalled();
    expect(recMock).toHaveBeenCalledTimes(1);
  });

  it('无素材 + 管理员已确认（confirm）→ 不再调识别直接生成，日志注明管理员已确认', async () => {
    makeBook();
    llmMock.mockResolvedValue({ cards: Array.from({ length: 30 }, (_, i) => card(i)) });
    const r = await runDraftStep('test-book', 'daily', '', 'a@b.c', undefined, root, {
      known: true,
      title: '测试之书',
      author: '某人',
      coreMethod: '金钱心理',
      note: '',
    });
    expect(r.ok).toBe(true);
    expect(recMock).not.toHaveBeenCalled(); // 确认过了，不烧第二次识别调用
    expect(r.log.join('\n')).toContain('AI 识别（管理员已确认）：《测试之书》，作者 某人，核心：金钱心理');
  });

  it('confirm.known !== true 视同未确认——照走识别闸（服务端兜底）', async () => {
    makeBook();
    recMock.mockResolvedValueOnce({ known: false, title: '', author: '', coreMethod: '', note: '没听过' });
    const r = await runDraftStep('test-book', 'daily', '', 'a@b.c', undefined, root, {
      known: false,
      title: '',
      author: '',
      coreMethod: '',
      note: '前端异常载荷',
    });
    expect(r.error).toBe('book_unknown');
    expect(recMock).toHaveBeenCalledTimes(1);
  });

  it('素材 ≥50 字符走素材路径，不触发识别闸', async () => {
    makeBook();
    llmMock.mockResolvedValue({ cards: Array.from({ length: 30 }, (_, i) => card(i)) });
    const r = await runDraftStep('test-book', 'daily', '素材'.repeat(40), 'a@b.c', undefined, root);
    expect(r.ok).toBe(true);
    expect(recMock).not.toHaveBeenCalled();
  });

  it('素材路径 + confirm 在场：confirm 不参与（素材即确认），日志不含「管理员已确认」', async () => {
    makeBook();
    llmMock.mockResolvedValue({ cards: Array.from({ length: 30 }, (_, i) => card(i)) });
    const r = await runDraftStep('test-book', 'daily', '素材'.repeat(40), 'a@b.c', undefined, root, {
      known: true,
      title: '测试之书',
      author: '某人',
      coreMethod: '',
      note: '',
    });
    expect(r.ok).toBe(true);
    expect(recMock).not.toHaveBeenCalled();
    expect(r.log.join('\n')).not.toContain('管理员已确认');
  });
});

describe('一签分批生成（3 批 × 30 → 合并全量校验 → en 逐批翻译）', () => {
  it('happy path：zh 90 条 + en 90 条写盘；后续批 prompt 带批号与防重样例', async () => {
    makeBook();
    llmMock.mockResolvedValue({ cards: Array.from({ length: 30 }, (_, i) => card(i)) });
    const r = await runDraftStep('test-book', 'daily', '素材'.repeat(40), 'a@b.c', undefined, root);
    expect(r.ok).toBe(true);
    expect(r.state?.daily['zh-CN']).toHaveLength(90);
    expect(r.state?.daily.en).toHaveLength(90);
    expect(llmMock).toHaveBeenCalledTimes(6); // zh×3 + en×3
    const zhBatch2 = String(llmMock.mock.calls[1]?.[0]?.messages?.[0]?.content);
    expect(zhBatch2).toContain('第 2 批');
    expect(zhBatch2).toContain('签文第 0 号'); // 第 1 批的开头样例进 prompt 防重复
    const enBatch2 = String(llmMock.mock.calls[4]?.[0]?.messages?.[0]?.content);
    expect(enBatch2).toContain('batch 2/3');
    // 落盘核验（pool.json 真写了）
    expect(readAdminBook('test-book', root)?.daily['zh-CN']).toHaveLength(90);
  });

  it('某一批不够 20 条 → draft_invalid（daily-batch1），校验错误进日志', async () => {
    makeBook();
    // 第 1 批两次尝试都只有 5 条（generateWithRetry 批内重试一次）→ 失败即停，不进第 2 批
    llmMock.mockResolvedValue({ cards: Array.from({ length: 5 }, (_, i) => card(i)) });
    const r = await runDraftStep('test-book', 'daily', '素材'.repeat(40), 'a@b.c', undefined, root);
    expect(r.error).toBe('draft_invalid');
    expect(r.stage).toBe('daily-batch1');
    expect(r.log.join('\n')).toContain('第 1 批未过校验');
    expect(llmMock).toHaveBeenCalledTimes(2);
  });

  it('每批 25 条（单批合法）合并只有 75 条 → 全量校验兜底拦下', async () => {
    makeBook();
    llmMock.mockResolvedValue({ cards: Array.from({ length: 25 }, (_, i) => card(i)) });
    const r = await runDraftStep('test-book', 'daily', '素材'.repeat(40), 'a@b.c', undefined, root);
    expect(r.error).toBe('draft_invalid');
    expect(r.stage).toBe('daily');
    expect(r.log.join('\n')).toContain('只有 75 条');
  });

  it('LLM 抛异常 → llm_failed，原因进日志（不向上抛）', async () => {
    makeBook();
    llmMock.mockRejectedValue(new Error('gateway 504'));
    const r = await runDraftStep('test-book', 'daily', '素材'.repeat(40), 'a@b.c', undefined, root);
    expect(r.error).toBe('llm_failed');
    expect(r.log.join('\n')).toContain('LLM 调用失败：gateway 504');
  });
});

describe('journey + 灯表链（识别放行 → 三次调用 → 写盘）', () => {
  it('happy path：journey 4 段（中英）+ 灯表 3 盏写盘，进度行进日志', async () => {
    makeBook();
    recMock.mockResolvedValueOnce({ known: true, title: '一生お金に困らない生き方', author: '心屋仁之助', coreMethod: '金钱心理', note: '构造一笔小确幸' });
    llmMock.mockResolvedValueOnce({ stages: [stage(1), stage(2), stage(3), stage(4)] });
    llmMock.mockResolvedValueOnce({ stages: { 1: [lamp('testbook_stage1_a')], 2: [lamp('testbook_stage2_a')], 3: [lamp('testbook_stage3_a')] } });
    llmMock.mockResolvedValueOnce({ stages: [stage(1), stage(2), stage(3), stage(4)] });
    const r = await runDraftStep('test-book', 'journey', '', 'a@b.c', undefined, root);
    expect(r.ok).toBe(true);
    expect(r.state?.journey['zh-CN']).toHaveLength(4);
    expect(r.state?.journey.en).toHaveLength(4);
    expect(Object.keys(r.state?.lamps ?? {})).toEqual(['1', '2', '3']);
    expect(r.log.join('\n')).toContain('AI 识别：作者 心屋仁之助');
    expect(r.log.join('\n')).toContain('journey zh-CN：4 段 ✅');
    expect(r.log.join('\n')).toContain('灯表：3 盏（四语齐）✅');
    expect(llmMock).toHaveBeenCalledTimes(3);
  });
});
