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

// ---- 全局串行锁 ----
// 网关（Anthropic 兼容层）在并发流下会把不同请求的 SSE 混写（实测：两条回复
// 字符级交错成乱文、另一请求瞬间"吃"到本流的缓冲提前结束）。陪伴场景本就是
// 单用户低并发，MVP 全局串行：任一时刻最多一个 LLM 请求在途，从触发条件上
// 根除串流。安全层分类与对话流是顺序调用（不嵌套拿锁），无死锁风险；
// 一个在途请求最长 45s（超时兜底），排队延迟可接受。
let llmChain: Promise<unknown> = Promise.resolve();

async function withLlmLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = llmChain.then(fn, fn);
  llmChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function* withLlmLockStream<T>(gen: AsyncGenerator<T>): AsyncGenerator<T> {
  const release = await acquireLock();
  try {
    yield* gen;
  } finally {
    release();
  }
}

function acquireLock(): Promise<() => void> {
  let release!: () => void;
  // gate 只在本人释放时 resolve；它是留给「下一个排队者」的等待点。
  // 注意不能让「发 release 给本人」的 promise 采纳 gate——那样要等 gate
  // resolve 才能拿到 release，而 gate 又要等 release 被调用 → 自锁。
  const gate = new Promise<void>((resolve) => (release = resolve));
  const turn = llmChain.then(() => release, () => release); // 前一个持有者结束 = 轮到我
  llmChain = gate;
  return turn;
}

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

/** usage 观测日志（只记 token 数，不落任何内容——P§9 纪律）；单位经济测算的数据源 */
function logUsage(provider: LlmProvider, kind: 'complete' | 'stream', input: number | undefined, output: number | undefined): void {
  console.error(`[llm] usage kind=${kind} provider=${provider.id} model=${provider.model} in=${input ?? '?'} out=${output ?? '?'}`);
}

/**
 * 非流式补全：按 provider 顺序逐个试，任一失败切下一个，全部失败抛最后异常。
 */
export async function llmComplete(opts: LlmCallOptions): Promise<string> {
  return withLlmLock(async () => {
    const providers = getLlmProviders();
    if (providers.length === 0) throw new Error('未配置任何 LLM provider（ANTHROPIC_AUTH_TOKEN）');

    let lastError: unknown;
    for (const provider of providers) {
      try {
        const client = newClient(provider);
        const response = await client.messages.create(callParams(provider, opts), {
          signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        logUsage(provider, 'complete', response.usage?.input_tokens, response.usage?.output_tokens);
        return textOf(response);
      } catch (error) {
        lastError = error;
        console.error(`[llm] provider ${provider.id} failed:`, error);
      }
    }
    throw lastError ?? new Error('LLM 调用失败');
  });
}

/**
 * 流式补全：返回 text 增量的异步可迭代。首个内容块到来前的失败（网络/网关拒绝）
 * 会切换 provider 重试；已开始输出后不再切换（客户端已收到一半内容）。
 * 全部 provider 连首块都拿不到时抛最后异常。
 */
export function llmStream(opts: LlmCallOptions): AsyncGenerator<string> {
  // 持锁范围 = 迭代器全程（首个 next() 拿锁，return/throw 释放）——
  // 调用方中途 break 时 for await 会触发 return()，finally 仍能释放锁
  return withLlmLockStream(rawLlmStream(opts));
}

async function* rawLlmStream(opts: LlmCallOptions): AsyncGenerator<string> {
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
      let usageIn: number | undefined;
      let usageOut: number | undefined;
      for await (const event of stream) {
        if (event.type === 'message_start') usageIn = event.message.usage?.input_tokens;
        if (event.type === 'message_delta' && event.usage) usageOut = event.usage.output_tokens;
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          started = true;
          yield event.delta.text;
        }
      }
      logUsage(provider, 'stream', usageIn, usageOut);
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
