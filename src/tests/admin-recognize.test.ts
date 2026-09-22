// 书目识别测试（输入书名自动生成的守门员）：结构校验纯函数 + recognizeBook 的
// 重试与 fail-open 语义（llmCompleteJson 用 mock，不打真网关）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRecognizeSystem,
  buildRecognizeUser,
  recognizeBook,
  validateRecognition,
  type BookRecognition,
} from '@/lib/admin-recognize';
import { llmCompleteJson } from '@/lib/llm';

vi.mock('@/lib/llm', () => ({ llmCompleteJson: vi.fn() }));

const llmMock = vi.mocked(llmCompleteJson);

beforeEach(() => {
  llmMock.mockReset();
});

describe('validateRecognition（结构校验）', () => {
  it('known:true / known:false 都是合法输出（known:false 是有效结论，不是错误）', () => {
    expect(validateRecognition({ known: true, author: '岸见一郎', note: '阿德勒心理学' })).toEqual([]);
    expect(validateRecognition({ known: false, author: '', note: '没听过这本书' })).toEqual([]);
  });

  it('5 字段全量（2026-09-23 确认闸：title/coreMethod 供确认卡展示）也是合法输出', () => {
    expect(validateRecognition({ known: true, title: '被讨厌的勇气', author: '岸见一郎', coreMethod: '课题分离', note: '' })).toEqual([]);
  });

  it('非对象 / known 缺失或非布尔被点名', () => {
    expect(validateRecognition(null)).toEqual(['识别输出缺少 JSON 对象']);
    expect(validateRecognition([1])).toEqual(['识别输出缺少 JSON 对象']);
    expect(validateRecognition({ author: '某人' })).toEqual(['known 必须是布尔']);
    expect(validateRecognition({ known: 'true' })).toEqual(['known 必须是布尔']);
  });
});

describe('recognizeBook（两次机会 + fail-open）', () => {
  it('known:false 原样返回——不重试（不认识是有效结论）', async () => {
    llmMock.mockResolvedValueOnce({ known: false, title: '', author: '', coreMethod: '', note: '没听过' });
    const rec = await recognizeBook('不存在的书', '', 'u:admin');
    expect(rec).toEqual({ known: false, title: '', author: '', coreMethod: '', note: '没听过' });
    expect(llmMock).toHaveBeenCalledTimes(1);
  });

  it('known:true 归一 author/title/coreMethod/note；缺失字段落空串', async () => {
    llmMock.mockResolvedValueOnce({
      known: true,
      title: ' 一生お金に困らない生き方 ',
      author: ' 心屋仁之助 ',
      coreMethod: ' 金钱心理 ',
      note: '构造一笔小确幸',
    } as BookRecognition);
    const rec = await recognizeBook('一生お金に困らない生き方', '', 'u:admin');
    expect(rec.known).toBe(true);
    expect(rec.title).toBe('一生お金に困らない生き方'); // trim
    expect(rec.author).toBe('心屋仁之助'); // trim
    expect(rec.coreMethod).toBe('金钱心理'); // trim
    expect(rec.note).toBe('构造一笔小确幸');

    llmMock.mockResolvedValueOnce({ known: true } as BookRecognition);
    const bare = await recognizeBook('某书', '', 'u:admin');
    expect(bare.title).toBe('');
    expect(bare.author).toBe('');
    expect(bare.coreMethod).toBe('');
    expect(bare.note).toBe('');
  });

  it('第一次结构不合法带错误清单重试，第二次通过', async () => {
    llmMock.mockResolvedValueOnce({ author: '某人' } as BookRecognition); // 缺 known
    llmMock.mockResolvedValueOnce({ known: true, author: '某人', note: '' } as BookRecognition);
    const rec = await recognizeBook('某书', '', 'u:admin');
    expect(rec.known).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(2);
    const retryMsg = String(llmMock.mock.calls[1]?.[0]?.messages?.[0]?.content ?? '');
    expect(retryMsg).toContain('known 必须是布尔');
  });

  it('两次都拿不到合法 JSON → fail-open（known:true + 字段全空 + note 注明），不拦死运营', async () => {
    llmMock.mockResolvedValue(null);
    const rec = await recognizeBook('某书', '', 'u:admin');
    expect(rec.known).toBe(true);
    expect(rec.title).toBe('');
    expect(rec.author).toBe('');
    expect(rec.coreMethod).toBe('');
    expect(rec.note).toContain('fail-open');
    expect(llmMock).toHaveBeenCalledTimes(2);
  });

  it('user prompt 带书名；作者缺省落「未提供」；system 钉「不配合不编造」+ 报书名/核心方法', async () => {
    llmMock.mockResolvedValueOnce({ known: true } as BookRecognition);
    await recognizeBook('被讨厌的勇气', '岸见一郎', 'u:admin');
    const opts = llmMock.mock.calls[0]?.[0];
    expect(String(opts?.messages?.[0]?.content)).toContain('《被讨厌的勇气》');
    expect(String(opts?.messages?.[0]?.content)).toContain('作者：岸见一郎');
    expect(String(opts?.system)).toContain('不要为了配合而编造');
    expect(String(opts?.system)).toContain('coreMethod');
    expect(buildRecognizeUser('某书', '')).toContain('作者：（未提供）');
    expect(buildRecognizeSystem()).toContain('known:false');
  });
});
