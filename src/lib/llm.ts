// LLM 管线：Anthropic 兼容网关 + provider failover（移植哄哄 llm-providers 模式）。
// 2026-09-16 升级：多 provider 自动 failover（设计稿 docs/design/multi-provider-failover.md §8）。
// - ProviderHealth 状态机：连续失败 → cooldown（指数退避 10s/30s/60s/300s 封顶 5min）
// - SSE 解析容错（parseEvent 单 event try/catch，畸形 event 跳过不抛）
// - 流中途失败 → 切下一个 provider 整请求重发 + 透传 providerSwitch marker 给前端
// - 写 llm_provider_events 表留历史（apiKey / baseURL / prompt / response 严禁进表）
// 智谱 glm 网关默认开思考，thinking 块导致 8s~45s+ 延迟，全部调用关闭（见 honghong 实测）。
import Anthropic from '@anthropic-ai/sdk';

import { getProviderHealth } from './llm-health';
import { logProviderEvent, newCallId } from './llm-log';
import { parseEvent, classifyError } from './llm-sse-parse';

export interface LlmProvider {
  id: string;
  /** Anthropic 兼容 endpoint base URL（含协议、不含 /v1/messages） */
  baseURL: string;
  apiKey: string;
  model: string;
  label: string;
  /**
   * 仅 marker：是否参与 failover 循环。false 时 ProviderHealth 把它从 retry 列表排除。
   * 真正 source of truth 是 ProviderHealth.isEnabled(id)——这里在对象上 inline 标记便于
   * 调用方快速过滤，且测试场景可临时改 marker 模拟。
   */
  enabled: boolean;
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
      enabled: true,
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
      enabled: true,
    });
  }

  // 用 ProviderHealth 二次过滤：cooldown 内的 provider 一律排除
  const health = getProviderHealth();
  return list.filter((p) => health.isEnabled(p.id));
}

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Provider 切换 marker：在 rawLlmStream 中途失败切下一个 provider 时 yield，
 * API 层捕获后转成 SSE `event: provider_switch` 给前端。
 * 详见设计稿 §8.3。
 */
export interface ProviderSwitchMarker {
  __providerSwitch: true;
  from: string;
  to: string;
  reason: 'server_5xx' | 'stream_throw' | 'config_4xx' | 'timeout' | 'rate_limit';
  chunksYielded: number;
}

/** llmStream yield 类型：string（增量）或 providerSwitch marker。 */
export type LlmStreamChunk = string | ProviderSwitchMarker;

interface LlmCallOptions {
  system: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  /** 无 SDK 层超时的兜底（AbortSignal），默认 45s——哄哄实测网关延迟波动大 */
  timeoutMs?: number;
  /**
   * 内部透传字段：调用方（API 路由层）设置，用于把同一请求的多条 llm_provider_events
   * 关联起来。不传给 SDK；不进 logProviderEvent 之外的日志。
   */
  callId?: string;
  /** 用途标识，例：'chat.stream' | 'onboarding.talk' | 'portrait'。进 log。 */
  callPurpose?: string;
  /** 当前请求的 user_key（u:<id> | g:<cookie>）。进 log。 */
  userKey?: string;
  /**
   * providerSwitch 回调（仅 llmStream 路径触发）。
   * llmComplete 路径不调用——非流式没有「中途」概念。
   */
  onProviderSwitch?: (e: { from: string; to: string; reason: ProviderSwitchMarker['reason']; chunksYielded: number }) => void;
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
 * 2026-09-16 升级：走 ProviderHealth 状态机记录每个 provider 的失败/成功/限流，
 * cooldown 内的 provider 直接跳过（不进 retry 列表）。
 */
export async function llmComplete(opts: LlmCallOptions): Promise<string> {
  return withLlmLock(async () => {
    const providers = getLlmProviders();
    if (providers.length === 0) throw new Error('未配置任何 LLM provider（ANTHROPIC_AUTH_TOKEN）');

    const callId = opts.callId ?? newCallId();
    const health = getProviderHealth();
    let lastError: unknown;
    for (const provider of providers) {
      const start = Date.now();
      try {
        await logProviderEvent({
          providerId: provider.id,
          callId,
          kind: 'start',
          callPurpose: opts.callPurpose ?? 'unknown',
          userKey: opts.userKey,
        });
        const client = newClient(provider);
        const response = await client.messages.create(callParams(provider, opts), {
          signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        logUsage(provider, 'complete', response.usage?.input_tokens, response.usage?.output_tokens);
        health.recordSuccess(provider.id);
        await logProviderEvent({
          providerId: provider.id,
          callId,
          kind: 'success',
          durationMs: Date.now() - start,
          callPurpose: opts.callPurpose ?? 'unknown',
          userKey: opts.userKey,
        });
        return textOf(response);
      } catch (error) {
        lastError = error;
        const kind = classifyError(error);
        if (kind === 'rate_limit') health.recordRateLimit(provider.id);
        else health.recordFailure(provider.id, kind);
        console.error(`[llm] provider ${provider.id} failed:`, error);
        await logProviderEvent({
          providerId: provider.id,
          callId,
          kind: 'failure',
          errorKind: kind,
          durationMs: Date.now() - start,
          callPurpose: opts.callPurpose ?? 'unknown',
          userKey: opts.userKey,
        });
      }
    }
    throw lastError ?? new Error('LLM 调用失败');
  });
}

/**
 * 流式补全：返回 LlmStreamChunk 异步可迭代（string | ProviderSwitchMarker）。
 *
 * 升级（2026-09-16）：
 * - 首块前失败 → 切下一个 provider 重发
 * - 中途失败 → 也切下一个 provider，但 yield `{__providerSwitch: ...}` marker 给调用方
 *   让前端展示「已自动切换继续」（不清空已显示文本）
 * - SSE event 解析走 parseEvent（容错不抛）
 *
 * 所有 provider 连首块都拿不到时抛最后异常。
 */
export function llmStream(opts: LlmCallOptions): AsyncGenerator<LlmStreamChunk> {
  // 持锁范围 = 迭代器全程（首个 next() 拿锁，return/throw 释放）——
  // 调用方中途 break 时 for await 会触发 return()，finally 仍能释放锁
  return withLlmLockStream(rawLlmStream(opts));
}

async function* rawLlmStream(opts: LlmCallOptions): AsyncGenerator<LlmStreamChunk> {
  const allProviders = collectProviders();
  if (allProviders.length === 0) throw new Error('未配置任何 LLM provider（ANTHROPIC_AUTH_TOKEN）');

  const callId = opts.callId ?? newCallId();
  const health = getProviderHealth();
  let lastError: unknown;
  for (let i = 0; i < allProviders.length; i++) {
    const provider = allProviders[i];
    if (!health.isEnabled(provider.id)) continue;
    const start = Date.now();
    let started = false;
    let chunkCount = 0;
    let usageIn: number | undefined;
    let usageOut: number | undefined;
    try {
      await logProviderEvent({
        providerId: provider.id,
        callId,
        kind: 'start',
        callPurpose: opts.callPurpose ?? 'unknown',
        userKey: opts.userKey,
      });
      const client = newClient(provider);
      const stream = client.messages.stream(callParams(provider, opts), {
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      for await (const event of stream) {
        const r = parseEvent(event, {
          providerId: provider.id,
          callId,
          callPurpose: opts.callPurpose ?? 'unknown',
          userKey: opts.userKey,
        });
        if (r.action === 'yield_text' && typeof r.text === 'string') {
          started = true;
          chunkCount++;
          if (typeof r.usageIn === 'number') usageIn = r.usageIn;
          if (typeof r.usageOut === 'number') usageOut = r.usageOut;
          yield r.text;
        } else if (r.action === 'skip') {
          if (typeof r.usageIn === 'number') usageIn = r.usageIn;
          if (typeof r.usageOut === 'number') usageOut = r.usageOut;
        }
        // 'malformed' 已由 parseEvent 内部 logProviderEvent 处理，这里跳过即可
      }
      logUsage(provider, 'stream', usageIn, usageOut);
      health.recordSuccess(provider.id);
      await logProviderEvent({
        providerId: provider.id,
        callId,
        kind: 'success',
        durationMs: Date.now() - start,
        chunksYielded: chunkCount,
        callPurpose: opts.callPurpose ?? 'unknown',
        userKey: opts.userKey,
      });
      return;
    } catch (error) {
      lastError = error;
      const kind = classifyError(error);
      if (kind === 'rate_limit') health.recordRateLimit(provider.id);
      else health.recordFailure(provider.id, kind);
      console.error(`[llm] provider ${provider.id} failed:`, error);
      await logProviderEvent({
        providerId: provider.id,
        callId,
        kind: 'failure',
        errorKind: kind,
        durationMs: Date.now() - start,
        chunksYielded: chunkCount,
        callPurpose: opts.callPurpose ?? 'unknown',
        userKey: opts.userKey,
      });

      // 中途失败 → 切下一个 provider + emit marker（设计稿 §3.2 + §8.3）
      if (started) {
        const nextProvider = allProviders[i + 1];
        if (nextProvider) {
          const marker: ProviderSwitchMarker = {
            __providerSwitch: true,
            from: provider.id,
            to: nextProvider.id,
            reason: kind === 'rate_limit' ? 'rate_limit' : kind,
            chunksYielded: chunkCount,
          };
          opts.onProviderSwitch?.({
            from: marker.from,
            to: marker.to,
            reason: marker.reason,
            chunksYielded: marker.chunksYielded,
          });
          yield marker;
          // 不 return，继续 for 循环：rawLlmStream 会切到下一个 provider 重发
        }
      }
    }
  }
  throw lastError ?? new Error('LLM 流式调用失败');
}

/**
 * 收集所有 provider（不应用 cooldown 过滤）——rawLlmStream 内部要保留 fallback 候选。
 * 实际调用走的是 `getLlmProviders()`（已过滤），但 rawLlmStream 在中途切时需要看完整列。
 * 注意：rawLlmStream 顶部 `if (!health.isEnabled(provider.id)) continue;` 已过滤 cooldown 内 provider。
 */
function collectProviders(): LlmProvider[] {
  // 这里复用 getLlmProviders() 的 env 读取，但跳过 cooldown 过滤
  // 简化：再读一次 env（每次只查 env，不实例化 SDK）
  const list: LlmProvider[] = [];
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    list.push({
      id: 'zhipu',
      baseURL: process.env.ANTHROPIC_BASE_URL || ZHIPU_BASE_URL,
      apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
      model: process.env.ANTHROPIC_MODEL || ZHIPU_DEFAULT_MODEL,
      label: '智谱 glm',
      enabled: true,
    });
  }
  if (process.env.LLM_PROVIDER_2_BASE_URL && process.env.LLM_PROVIDER_2_AUTH_TOKEN && process.env.LLM_PROVIDER_2_MODEL) {
    list.push({
      id: 'provider-2',
      baseURL: process.env.LLM_PROVIDER_2_BASE_URL,
      apiKey: process.env.LLM_PROVIDER_2_AUTH_TOKEN,
      model: process.env.LLM_PROVIDER_2_MODEL,
      label: '备用 LLM 1',
      enabled: true,
    });
  }
  return list;
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