// APNs 直发客户端（docs/11 M2）：token-based 认证（.p8 签 ES256 JWT）+ HTTP/2。
//
// 为什么不用现成库：@parse/node-apn 之流把连接池/重试背进来，我们只发节点信——
// 一轮几十条、一天一次的量，http2 现连现断完全够。少一个依赖少一份陈旧风险。
// 为什么 JWT 手签却用 jose：ES256 的 r||s 原始签名格式手搓极易错一位，jose 是
// better-auth 同款已在树上的标准件，这部分不值得省。
//
// 环境变量（docs/11 §7——.p8 与 Key ID 走私下渠道给到，不进仓库）：
//   APNS_P8      .p8 文件内容（PEM 原文或 base64 皆可，自动识别）
//   APNS_KEY_ID  生成 .p8 时的 Key ID（10 位）
//   APNS_TEAM_ID 开发者账号 Team ID
//   APNS_ENV     'sandbox' = 开发签名构建的设备；缺省 production（TestFlight/App Store）
//
// 错误语义对齐 touch/dispatch 的两类处置（见 route.ts isChannelError 注释）：
// 403/404 通道级错误（key 废了/路径坏）→ 抛 ApnsChannelError 让整轮中止；
// 410 Unregistered → 设备已卸载，抛 ApnsUnregisteredError 让调度器把 token 摘掉；
// 其余（超时/5xx）→ 抛普通错误，送没送到不好说，占位不回滚。
import { SignJWT, importPKCS8 } from 'jose';
import * as http2 from 'node:http2';

export const APNS_PRODUCTION_HOST = 'https://api.push.apple.com';
export const APNS_SANDBOX_HOST = 'https://api.sandbox.push.apple.com';

/** 环境里配的 .p8：PEM 原文直接用；base64（方便 env 单行）先解开。 */
export function decodeP8(raw: string): string {
  const s = raw.trim();
  if (s.includes('PRIVATE KEY')) return s.replace(/\\n/g, '\n');
  return Buffer.from(s, 'base64').toString('utf8');
}

export function apnsHost(): string {
  return process.env.APNS_ENV === 'sandbox' ? APNS_SANDBOX_HOST : APNS_PRODUCTION_HOST;
}

/**
 * 签 APNs provider token（ES256）。token 有效期 1 小时（Apple 文档上限），
 * 这里压到 30 分钟并进程内复用——签一次管半小时，一轮调度只签一次。
 * exported for tests：时间可注入，验证 kid/iss/exp 落位。
 */
export async function buildProviderJwt(nowMs: number = Date.now()): Promise<string> {
  const keyId = process.env.APNS_KEY_ID ?? '';
  const teamId = process.env.APNS_TEAM_ID ?? '';
  const key = await importPKCS8(decodeP8(process.env.APNS_P8 ?? ''), 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: keyId })
    .setIssuer(teamId)
    .setIssuedAt(Math.floor(nowMs / 1000))
    .setExpirationTime(Math.floor(nowMs / 1000) + 30 * 60)
    .sign(key);
}

let cachedJwt: { token: string; expMs: number } | null = null;

/** 进程内复用的 provider token：剩 5 分钟以内就重签（避开边界钟摆）。 */
async function providerJwt(): Promise<string> {
  const now = Date.now();
  if (cachedJwt && cachedJwt.expMs - now > 5 * 60_000) return cachedJwt.token;
  const token = await buildProviderJwt(now);
  cachedJwt = { token, expMs: now + 30 * 60_000 };
  return token;
}

export class ApnsChannelError extends Error {} // 403/401：key 废了——整轮该停
export class ApnsUnregisteredError extends Error {} // 410：设备卸载——摘 token，继续

export interface ApnsAlert {
  title: string;
  body: string;
}

/** alert 载荷（与 mute/state 无关的节点信都走 alert）。url 进自定义键，壳内 tap 接住跳站内。 */
export function apnsPayload(alert: ApnsAlert, url: string): string {
  return JSON.stringify({
    aps: { alert: { title: alert.title, body: alert.body }, sound: 'default' },
    url,
  });
}

/**
 * 发一条。**调用方按错误类型分流**（见文件头）；本函数只负责把 HTTP 状态翻译成那三类。
 * 连接现连现断：Node http2 对 APNs 的长连接在事件循环里是个常驻把手，一轮调度里
 * 显式 close 才能让进程干净退出（systemd timer 打完就走的形态）。
 */
export async function sendApns(deviceToken: string, payload: string): Promise<void> {
  const authority = apnsHost();
  const jwt = await providerJwt();
  const bundleId = process.env.APNS_TOPIC ?? 'ink.miller.honghong';

  await new Promise<void>((resolve, reject) => {
    const session = http2.connect(authority);
    session.on('error', (error) => {
      session.close();
      reject(error);
    });
    const req = session.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `Bearer ${jwt}`,
      'apns-topic': bundleId,
      'apns-push-type': 'alert',
      'content-length': String(Buffer.byteLength(payload)),
    });
    req.setEncoding('utf8');
    let status = 0;
    let body = '';
    req.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0);
    });
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('error', (error) => {
      session.close();
      reject(error);
    });
    req.on('end', () => {
      session.close();
      if (status === 200) return resolve();
      const reason = (() => {
        try {
          return String((JSON.parse(body) as { reason?: string }).reason ?? '');
        } catch {
          return '';
        }
      })();
      // 只认 410/Unregistered 为"设备已卸载"。BadDeviceToken 故意不算——它也可能是
      // sandbox/production 主机配错，算成卸载会把全表 token 误摘光。配错属通道事故，
      // 走普通错误（占位不回滚、token 不动），宁可漏。
      if (status === 410 || reason === 'Unregistered') {
        return reject(new ApnsUnregisteredError(`apns 410 ${reason}`));
      }
      if (status === 401 || status === 403) {
        return reject(new ApnsChannelError(`APNs HTTP ${status} ${reason}`));
      }
      reject(new Error(`APNs HTTP ${status} ${reason}`));
    });
    req.end(payload);
  });
}
