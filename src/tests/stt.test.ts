// STT provider 层单测（V0.2 批 D3，docs/02 §20.4）：env 组装 + failover + 健康状态机接线。
// stt.ts 用原生 fetch（无 SDK），mock global.fetch 即可；健康状态机用真 ProviderHealth。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SttHttpError, SttNotConfiguredError, STT_MAX_BYTES, getSttProviders, transcribe } from '@/lib/stt';
import { ProviderHealth, setProviderHealth } from '@/lib/llm-health';

const AUDIO = new Blob(['fake-audio-bytes'], { type: 'audio/webm' });

function fetchOk(text: string) {
  return new Response(JSON.stringify({ text }), { status: 200 });
}

const fetchMock = vi.hoisted(() => vi.fn());

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  setProviderHealth(new ProviderHealth());
  delete process.env.STT_PROVIDER_1_BASE_URL;
  delete process.env.STT_PROVIDER_1_API_KEY;
  delete process.env.STT_PROVIDER_1_MODEL;
  delete process.env.STT_PROVIDER_2_BASE_URL;
  delete process.env.STT_PROVIDER_2_API_KEY;
  delete process.env.STT_PROVIDER_2_MODEL;
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getSttProviders（env 组装）', () => {
  it('未配置 → 空列表（功能整体关闭）', () => {
    expect(getSttProviders()).toEqual([]);
  });

  it('三项全填才入列；缺一不可', () => {
    process.env.STT_PROVIDER_1_BASE_URL = 'https://stt.test/v1';
    process.env.STT_PROVIDER_1_API_KEY = 'k1';
    expect(getSttProviders()).toEqual([]); // 缺 MODEL
    process.env.STT_PROVIDER_1_MODEL = 'whisper-1';
    const list = getSttProviders();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'stt-1', baseURL: 'https://stt.test/v1', model: 'whisper-1' });
  });

  it('备用 STT_PROVIDER_2_* 同规则入列，id 顺序排布', () => {
    for (const n of [1, 2]) {
      process.env[`STT_PROVIDER_${n}_BASE_URL`] = `https://stt-${n}.test/v1`;
      process.env[`STT_PROVIDER_${n}_API_KEY`] = `k${n}`;
      process.env[`STT_PROVIDER_${n}_MODEL`] = 'asr';
    }
    expect(getSttProviders().map((p) => p.id)).toEqual(['stt-1', 'stt-2']);
  });
});

describe('transcribe（failover 照 llm 形状）', () => {
  beforeEach(() => {
    process.env.STT_PROVIDER_1_BASE_URL = 'https://stt-1.test/v1';
    process.env.STT_PROVIDER_1_API_KEY = 'k1';
    process.env.STT_PROVIDER_1_MODEL = 'asr-1';
    process.env.STT_PROVIDER_2_BASE_URL = 'https://stt-2.test/v1';
    process.env.STT_PROVIDER_2_API_KEY = 'k2';
    process.env.STT_PROVIDER_2_MODEL = 'asr-2';
  });

  it('未配置 → SttNotConfiguredError（路由层转 501）', async () => {
    for (const n of [1, 2]) {
      delete process.env[`STT_PROVIDER_${n}_BASE_URL`];
      delete process.env[`STT_PROVIDER_${n}_API_KEY`];
      delete process.env[`STT_PROVIDER_${n}_MODEL`];
    }
    await expect(transcribe(AUDIO)).rejects.toBeInstanceOf(SttNotConfiguredError);
  });

  it('成功：POST {baseURL}/audio/transcriptions，带 Bearer 与 model，返回 {text}', async () => {
    fetchMock.mockResolvedValueOnce(fetchOk('今天有点舍不得花钱'));
    const text = await transcribe(AUDIO, { filename: 'audio.webm' });
    expect(text).toBe('今天有点舍不得花钱');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://stt-1.test/v1/audio/transcriptions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k1');
    const form = init.body as FormData;
    expect(form.get('model')).toBe('asr-1');
    expect(form.get('file')).toBeInstanceOf(File);
  });

  it('首 provider 5xx → 切下一个成功', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    fetchMock.mockResolvedValueOnce(fetchOk('second provider'));
    await expect(transcribe(AUDIO)).resolves.toBe('second provider');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toContain('stt-2.test');
  });

  it('429 → rate_limit 短冷却（不占硬失败计数），下一个 provider 接手', async () => {
    fetchMock.mockResolvedValueOnce(new Response('limited', { status: 429 }));
    fetchMock.mockResolvedValueOnce(fetchOk('ok'));
    await expect(transcribe(AUDIO)).resolves.toBe('ok');
    expect(getSttProviders().map((p) => p.id)).toEqual(['stt-2']); // stt-1 冷却中被排除
  });

  it('连续硬失败 3 次 → 进入 cooldown，后续调用跳过', async () => {
    fetchMock.mockResolvedValue(new Response('down', { status: 500 }));
    for (let i = 0; i < 3; i++) {
      await transcribe(AUDIO).catch(() => null); // 每轮两个 provider 都试（2 次 fetch × 3 轮）
    }
    expect(getSttProviders()).toEqual([]);
    await expect(transcribe(AUDIO)).rejects.toBeInstanceOf(SttNotConfiguredError);
    expect(fetchMock).toHaveBeenCalledTimes(6); // 冷却后不再发请求
  });

  it('全部失败 → 抛最后一个错误（SttHttpError 只带状态码）', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }));
    await expect(transcribe(AUDIO)).rejects.toBeInstanceOf(SttHttpError);
  });

  it('转写为空串是合法结果（静音/没听清），不触发 failover', async () => {
    fetchMock.mockResolvedValueOnce(fetchOk(''));
    await expect(transcribe(AUDIO)).resolves.toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('边界', () => {
  it('STT_MAX_BYTES = 8MB（60 秒录音的宽松上限）', () => {
    expect(STT_MAX_BYTES).toBe(8 * 1024 * 1024);
  });
});
