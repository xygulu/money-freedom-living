// LLM 管线：Anthropic 兼容网关 + provider failover（移植哄哄 llm-providers 模式）。
// 配置层只读 env 拼对象，不实例化 SDK、不缓存——调用层负责循环。
// 智谱 glm 网关默认开思考，thinking 块导致 8s~45s+ 延迟，全部调用关闭（见 honghong 实测）。
import Anthropic from '@anthropic-ai/sdk';

export interface LlmProvider {
  id: string;
  /** Anthropic 兼容 endpoint base URL（含协议、不含 /v1/messages） */
  baseURL: string;
  apiKey: string;
  model: string;
  label: string;
}

const ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
const ZHIPU_DEFAULT_MODEL = 'glm-5.3-flash';

export function getLlmProviders(): LlmProvider[] {
  const list: LlmProvider[] = [];

  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    list.push({
      id: 'zhipu',
      baseURL: process.env.ANTHROPIC_BASE_URL || ZHIPU_BASE_URL,
      apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
      model: process.env.ANTHROPIC_MODEL || ZHIPU_DEFAULT_MODEL,
      label: '智谱 glm',
    });
  }

  // 备用 provider（Anthropic 兼容网关），三项全填才入列；LLM_PROVIDER_3_* 再复制一份即可
  if (process.env.LLM_PROVIDER_2_BASE_URL && process.env.LLM_PROVIDER_2_AUTH_TOKEN && process.env.LLM_PROVIDER_2_MODEL) {
    list.push({
      id: 'provider-2',
      baseURL: process.env.LLM_PROVIDER_2_BASE_URL,
      apiKey: process.env.LLM_PROVIDER_2_AUTH_TOKEN,
      model: process.env.LLM_PROVIDER_2_MODEL,
      label: '备用 LLM 1',
    });
  }

  return list;
}

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface LlmCallOptions {
  system: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  /** 无 SDK 层超时的兜底（AbortSignal），默认 45s——哄哄实测网关延迟波动大 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 45_000;

function newClient(provider: LlmProvider): Anthropic {
  return new Anthropic({ baseURL: provider.baseURL, apiKey: provider.apiKey });
}

function callParams(provider: LlmProvider, opts: LlmCallOptions): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: provider.model,
    max_tokens: opts.maxTokens ?? 2048,
    temperature: opts.temperature ?? 1,
    thinking: { type: 'disabled' },
    system: opts.system,
    messages: opts.messages,
  };
}

/** 只拼接 text 块（过滤 thinking 等非文本块） */
function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * 非流式补全：按 provider 顺序逐个试，任一失败切下一个，全部失败抛最后异常。
 */
export async function llmComplete(opts: LlmCallOptions): Promise<string> {
  const providers = getLlmProviders();
  if (providers.length === 0) throw new Error('未配置任何 LLM provider（ANTHROPIC_AUTH_TOKEN）');

  let lastError: unknown;
  for (const provider of providers) {
    try {
      const client = newClient(provider);
      const response = await client.messages.create(callParams(provider, opts), {
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      return textOf(response);
    } catch (error) {
      lastError = error;
      console.error(`[llm] provider ${provider.id} failed:`, error);
    }
  }
  throw lastError ?? new Error('LLM 调用失败');
}

/**
 * 流式补全：返回 text 增量的异步可迭代。首个内容块到来前的失败（网络/网关拒绝）
 * 会切换 provider 重试；已开始输出后不再切换（客户端已收到一半内容）。
 * 全部 provider 连首块都拿不到时抛最后异常。
 */
export async function* llmStream(opts: LlmCallOptions): AsyncGenerator<string> {
  const providers = getLlmProviders();
  if (providers.length === 0) throw new Error('未配置任何 LLM provider（ANTHROPIC_AUTH_TOKEN）');

  let lastError: unknown;
  for (const provider of providers) {
    try {
      const client = newClient(provider);
      const stream = client.messages.stream(callParams(provider, opts), {
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      let started = false;
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          started = true;
          yield event.delta.text;
        }
      }
      return;
    } catch (error) {
      // 首块前失败可切换；已输出后失败只能中止（调用方已收到部分内容）
      lastError = error;
      console.error(`[llm] provider ${provider.id} failed:`, error);
    }
  }
  throw lastError ?? new Error('LLM 流式调用失败');
}

/**
 * 从 LLM 文本里提取 JSON 对象：容忍 ```json 围栏与前后闲话。
 * 找不到合法 JSON 返回 null（调用方决定重试/降级，禁止编造默认画像）。
 */
export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.search(/[[{]/);
    if (start === -1) continue;
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    if (end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1)) as T;
    } catch {
      // 继续下一个候选
    }
  }
  return null;
}

/** 非流式补全 + JSON 提取：结构不对返回 null，由调用方决定重试策略 */
export async function llmCompleteJson<T>(opts: LlmCallOptions): Promise<T | null> {
  const text = await llmComplete({ ...opts, temperature: 0.3 });
  return extractJson<T>(text);
}
