import { describe, it, expect, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { decodeP8, buildProviderJwt, apnsPayload, apnsHost, APNS_PRODUCTION_HOST, APNS_SANDBOX_HOST } from '../lib/push-apns';

// APNs 客户端里能单测的部分：.p8 解码、provider JWT 的三件套落位、payload 形状、主机选择。
// 真正的网络发送（sendApns）不在单测范围——那需要 mock 整个 http2，收益配不上成本，
// 它的分流逻辑（410 摘牌/403 停轮/5xx 留占位）靠类型语义与 dispatch 侧的实例判断保证。

function makeP8(): string {
  // 测试现场生成 P-256 私钥（PKCS#8 PEM）——不把任何真实 key 提交进仓库
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

describe('decodeP8：PEM 原文与 base64 两种形态都认', () => {
  it('PEM 原文（含 env 转义的 \\n）原样保留（decodeP8 会 trim 首尾，期望值同步 trim）', () => {
    const pem = makeP8().trim();
    expect(decodeP8(pem)).toBe(pem);
    expect(decodeP8(pem.replace(/\n/g, '\\n'))).toBe(pem);
  });

  it('base64（env 单行形态）解开成 PEM', () => {
    const pem = makeP8();
    expect(decodeP8(Buffer.from(pem).toString('base64'))).toBe(pem);
  });
});

describe('buildProviderJwt：ES256 三件套（kid/iss/exp）落位', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('header 带 alg=ES256 + kid，payload 带 iss（Team ID）与 ≤1h 的 exp', async () => {
    const pem = makeP8();
    vi.stubEnv('APNS_P8', pem);
    vi.stubEnv('APNS_KEY_ID', 'KID1234567');
    vi.stubEnv('APNS_TEAM_ID', 'TEAM123456');
    const now = Date.now();
    const jwt = await buildProviderJwt(now);
    const [h, p] = jwt.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    expect(header).toEqual({ alg: 'ES256', kid: 'KID1234567' });
    expect(payload.iss).toBe('TEAM123456');
    expect(payload.iat).toBe(Math.floor(now / 1000));
    expect(payload.exp - payload.iat).toBe(30 * 60); // 30 分钟，压着 Apple 1h 上限内
  });
});

describe('apnsPayload / apnsHost', () => {
  it('alert 进 aps.alert，url 进自定义键（壳内 tap 据此站内跳转）', () => {
    const parsed = JSON.parse(apnsPayload({ title: '题', body: '句' }, 'https://x.example/zh-CN/journey-new')) as {
      aps: { alert: { title: string; body: string }; sound: string };
      url: string;
    };
    expect(parsed.aps.alert).toEqual({ title: '题', body: '句' });
    expect(parsed.aps.sound).toBe('default');
    expect(parsed.url).toBe('https://x.example/zh-CN/journey-new');
  });

  it('APNS_ENV=sandbox 指沙箱（开发签名构建），缺省生产（TestFlight/App Store）', () => {
    vi.stubEnv('APNS_ENV', 'sandbox');
    expect(apnsHost()).toBe(APNS_SANDBOX_HOST);
    vi.stubEnv('APNS_ENV', '');
    expect(apnsHost()).toBe(APNS_PRODUCTION_HOST);
  });
});
