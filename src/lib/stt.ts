// 服务端 STT provider 层（V0.2 批 D3，docs/02 §20.4：浏览器 SpeechRecognition 不作主方案）。
// 形状照 llm.ts / llm-health.ts：env 驱动 provider 列表 + ProviderHealth failover
// （复用同一个健康单例，id 用 stt-1/stt-2 前缀与 LLM provider 不冲突）。
// - API 形状取 OpenAI 兼容 `POST {baseURL}/audio/transcriptions`（multipart: file+model → {text}），
//   事实标准，多数厂商/网关通用；provider 真实选型由 env 决定，代码不绑厂商。
// - 未配置（env 三项不全）= 功能整体关闭：按钮不渲染、路由 501（照 M6 支付 NOT_CONFIGURED 先例）。
// - **音频与转写文本绝不落日志**（P§9 纪律）——日志只有 provider id / 耗时 / 字节数。
//   音频只在请求内存中转发，转写完成即弃；转写不做分析、不打标签（产品边界）。
// - 语言提示不传：OpenAI 兼容实现对此参数行为不一（有的严格校验拒请求），
//   whisper 系自动检测够用；要传时加 `language` 字段并逐 provider 验证。

import { getProviderHealth, type FailureKind } from './llm-health';

export interface SttProvider {
  id: string;
  /** OpenAI 兼容 transcription endpoint base URL（不含 /audio/transcriptions，容忍尾部斜杠） */
  baseURL: string;
  apiKey: string;
  model: string;
  label: string;
}

/** 未配置任何 STT provider 时抛出——路由层转 501 stt_not_configured */
export class SttNotConfiguredError extends Error {
  constructor() {
    super('未配置任何 STT provider（STT_PROVIDER_1_*）');
  }
}

/** 60 秒录音（webm/opus ≈ 0.5MB、mp4/aac 略高）的宽松上限；超限直接 413，不转发 */
export const STT_MAX_BYTES = 8 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 30_000;

export function getSttProviders(): SttProvider[] {
  const list: SttProvider[] = [];
  if (process.env.STT_PROVIDER_1_BASE_URL && process.env.STT_PROVIDER_1_API_KEY && process.env.STT_PROVIDER_1_MODEL) {
    list.push({
      id: 'stt-1',
      baseURL: process.env.STT_PROVIDER_1_BASE_URL,
      apiKey: process.env.STT_PROVIDER_1_API_KEY,
      model: process.env.STT_PROVIDER_1_MODEL,
      label: 'STT 1',
    });
  }
  // 备用 provider，三项全填才入列；STT_PROVIDER_3_* 再复制一份即可（照 llm.ts 形状）
  if (process.env.STT_PROVIDER_2_BASE_URL && process.env.STT_PROVIDER_2_API_KEY && process.env.STT_PROVIDER_2_MODEL) {
    list.push({
      id: 'stt-2',
      baseURL: process.env.STT_PROVIDER_2_BASE_URL,
      apiKey: process.env.STT_PROVIDER_2_API_KEY,
      model: process.env.STT_PROVIDER_2_MODEL,
      label: 'STT 2',
    });
  }
  // cooldown 内的 provider 一律排除（与 llm.ts 同一个健康状态机）
  const health = getProviderHealth();
  return list.filter((p) => health.isEnabled(p.id));
}

function classify(status: number, aborted: boolean): FailureKind {
  if (aborted) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 400 && status < 500) return 'config_4xx'; // key/baseURL/model 配置错
  return 'server_5xx';
}

export interface TranscribeOptions {
  filename?: string;
  timeoutMs?: number;
  /** 用途标识（日志观察用，不含内容） */
  callPurpose?: string;
}

/**
 * 转写一段音频，返回文本（可能为空串——静音/没听清是合法结果，不是错误，
 * 由调用方决定提示口径）。按 provider 顺序逐个试，任一失败切下一个，
 * 全部失败抛最后一个异常。空串不触发 failover（换 provider 也听不出更多）。
 */
export async function transcribe(audio: Blob, opts: TranscribeOptions = {}): Promise<string> {
  const allProviders = getSttProviders();
  if (allProviders.length === 0) throw new SttNotConfiguredError();

  const health = getProviderHealth();
  let lastError: unknown;
  for (const provider of allProviders) {
    const start = Date.now();
    try {
      const form = new FormData();
      form.append('file', audio, opts.filename ?? 'audio.webm');
      form.append('model', provider.model);
      const res = await fetch(`${provider.baseURL.replace(/\/+$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) throw new SttHttpError(res.status);
      const data = (await res.json()) as { text?: unknown };
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      health.recordSuccess(provider.id);
      // 只记元数据（P§9）：字节数/耗时/provider，绝不记音频或文本
      console.error(`[stt] ok provider=${provider.id} bytes=${audio.size} ms=${Date.now() - start}${opts.callPurpose ? ` purpose=${opts.callPurpose}` : ''}`);
      return text;
    } catch (error) {
      lastError = error;
      const aborted = error instanceof Error && error.name === 'TimeoutError';
      const status = error instanceof SttHttpError ? error.status : 0;
      const kind = classify(status, aborted);
      if (kind === 'rate_limit') health.recordRateLimit(provider.id);
      else health.recordFailure(provider.id, kind);
      // 只记状态码，不记响应体（响应体可能回显内容）
      console.error(`[stt] provider ${provider.id} failed kind=${kind} status=${status} bytes=${audio.size}`);
    }
  }
  throw lastError ?? new Error('STT 调用失败');
}

/** 仅携带状态码的 HTTP 错误——日志纪律：不保留响应体 */
export class SttHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`STT HTTP ${status}`);
    this.status = status;
  }
}
