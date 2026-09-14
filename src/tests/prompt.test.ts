import { describe, expect, it } from 'vitest';
import { buildChatContext, HISTORY_BUDGET } from '@/lib/prompt';
import { validateDigest, DIGEST_SYSTEM } from '@/lib/memory';
import type { Portrait, SessionMemory } from '@/lib/profile';
import type { Locale } from '@/i18n/config';

function portrait(): Portrait {
  return {
    spoken: ['我妈说，咱家不配。'],
    baseColor: '花钱那一刻总有个声音说再省一点。'.repeat(3),
    moments: [{ title: '试衣间', detail: '付完钱手在抖' }],
    script: '也许「咱家不配」。',
    toFuture: '慢慢来。',
    version: 1,
    calibrations: [],
    scriptStatus: 'pending',
  };
}

const base = {
  locale: 'zh-CN' as Locale,
  stage: 1,
  concerns: [],
  pinned: [],
  memories: [] as SessionMemory[],
  history: [],
  stableMode: false,
  opener: false,
  tz: 'Asia/Shanghai',
  now: new Date('2026-09-14T01:20:00Z'), // = 北京时间 9/14 09:20，断言里按这个算远近
};

describe('buildChatContext：P§6 优先级组装', () => {
  it('安全规则永远是第一个块', () => {
    const { system } = buildChatContext(base);
    expect(system.indexOf('安全规则')).toBeGreaterThan(-1);
    expect(system.trim().startsWith('## 安全规则')).toBe(true);
  });

  it('pinned 按 禁忌>承诺>未完成 排序，且超过预算也不裁（在 memories 之前）', () => {
    const { system } = buildChatContext({
      ...base,
      pinned: [
        { kind: 'open', text: '加薪话题聊到一半' },
        { kind: 'promise', text: '这周记三次账' },
        { kind: 'taboo', text: '别再提我爸' },
      ],
    });
    const tabooAt = system.indexOf('别再提我爸');
    const promiseAt = system.indexOf('这周记三次账');
    const openAt = system.indexOf('加薪话题聊到一半');
    expect(tabooAt).toBeLessThan(promiseAt);
    expect(promiseAt).toBeLessThan(openAt);
  });

  it('脚本只有 confirmed 才注入（pending/rejected 不进长期工作记忆，P§2）', () => {
    const pending = buildChatContext({ ...base, portrait: portrait() });
    expect(pending.system).not.toContain('也许「咱家不配」');

    const confirmed = buildChatContext({ ...base, portrait: { ...portrait(), scriptStatus: 'confirmed' } });
    expect(confirmed.system).toContain('也许「咱家不配」');

    const rejected = buildChatContext({ ...base, portrait: { ...portrait(), scriptStatus: 'rejected' } });
    expect(rejected.system).not.toContain('也许「咱家不配」');
  });

  it('spoken/底色/瞬间/开放 concerns/阶段引导注入', () => {
    const { system } = buildChatContext({
      ...base,
      portrait: portrait(),
      concerns: [{ content: '买外套内疚三天', status: 'open' }, { content: '已化解的旧事', status: 'closed' }],
    });
    expect(system).toContain('咱家不配');
    expect(system).toContain('买外套内疚三天');
    expect(system).not.toContain('已化解的旧事');
    expect(system).toContain('看见'); // 阶段 1 标题出现在 system
  });

  it('memories 只取最近 5 条、每条截断', () => {
    const memories: SessionMemory[] = Array.from({ length: 8 }, (_, i) => ({
      date: `2026-09-0${i + 1}`,
      text: `记忆${i}：${'很长的内容'.repeat(80)}`,
    }));
    const { system } = buildChatContext({ ...base, memories });
    expect(system).toContain('记忆7');
    expect(system).toContain('记忆3'); // slice(-5) = 第 3-7 条
    expect(system).not.toContain('记忆2：');
    expect(system).not.toContain('记忆0：');
  });

  it('stableMode 注入稳定陪伴模式；opener 注入开场指令', () => {
    expect(buildChatContext({ ...base, stableMode: true }).system).toContain('稳定陪伴模式');
    expect(buildChatContext({ ...base, opener: true }).system).toContain('开场');
    expect(buildChatContext(base).system).not.toContain('稳定陪伴模式');
  });

  it('「现在」块：用户本地时间进 system，且排在内容块之前（预算裁不到）', () => {
    const { system } = buildChatContext(base);
    expect(system).toContain('## 现在');
    expect(system).toContain('Asia/Shanghai');
    expect(system).toContain('2026年9月14日'); // 那一刻 UTC 还是 9/13，必须按用户时区说 9/14
    expect(system.indexOf('## 现在')).toBeLessThan(system.indexOf('## 当前阶段'));
  });

  it('记忆日期带远近说法（模型不知道今天几号，得直接告诉它）', () => {
    const memories: SessionMemory[] = [
      { date: '2026-09-13', text: '昨天那条' },
      { date: '2026-08-31', text: '半个月前那条' },
    ];
    const { system } = buildChatContext({ ...base, memories });
    expect(system).toContain('[2026-09-13 · 昨天]');
    expect(system).toContain('[2026-08-31 · 2 周前]');
  });

  it('对话历史从最新往回装进预算，最旧的先被裁', () => {
    const history = Array.from({ length: 50 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `消息${i}：${'x'.repeat(200)}`,
    }));
    const { messages } = buildChatContext({ ...base, history });
    const joined = messages.map((m) => m.content).join();
    expect(messages.length).toBeLessThan(history.length);
    expect(joined).toContain(`消息49`);
    expect(joined).not.toContain(`消息0：`);
    expect(messages.reduce((sum, m) => sum + m.content.length, 0)).toBeLessThanOrEqual(HISTORY_BUDGET);
    // 时序不乱：裁剪后仍按时间正序（首条编号 < 末条编号，且角色交替保持 user 开头）
    const numAt = (i: number) => Number(messages[i].content.match(/消息(\d+)/)![1]);
    expect(numAt(0)).toBeLessThan(numAt(messages.length - 1));
  });
});

describe('每日两问协议 + 五类失败接法（docs/10 §1.2，硬约束不进裁剪）', () => {
  it('协议块在系统提示里，且紧跟安全规则（不排到会被预算裁掉的末尾）', () => {
    const { system } = buildChatContext(base);
    expect(system).toContain('一天最多两问');
    const safetyAt = system.indexOf('## 安全规则');
    const protocolAt = system.indexOf('一天最多两问');
    expect(protocolAt).toBeGreaterThan(safetyAt);
    // 排在内容层之前：预算不足时先裁内容，不能先裁约束
    expect(protocolAt).toBeLessThan(system.indexOf('## 现在'));
  });

  it('两块各自带标题，是独立块而不是塞在别处的两句话', () => {
    const { system } = buildChatContext(base);
    expect(system).toContain('## 一天最多两问（硬约束）');
    expect(system).toContain('他答不上来时怎么接');
  });

  it('三个数字口径逐条在场：最多两个 / 不同时出现 / 先行为后认知', () => {
    const { system } = buildChatContext(base);
    expect(system).toContain('你最多问两个问题');
    expect(system).toContain('不能出现在同一条回复里');
    expect(system).toContain('先行为、后认知');
  });

  it('五类失败接法一类不落（说没做/不知道/只回一个字/反问回来/情绪为负）', () => {
    const { system } = buildChatContext(base);
    for (const marker of ['没做', '不知道', '只回一个字', '反问回来', '情绪为负']) {
      expect(system).toContain(marker);
    }
  });

  it('「没做」那一类写死不准安慰——安慰一出现，选项就塌成只能填"做了"', () => {
    const { system } = buildChatContext(base);
    expect(system).toContain('不安慰、不鼓励、不提明天');
    expect(system).toContain('打卡表');
  });

  it('四语都有这两块，且各语都点到自己的语言（漏语言＝某语用户拿到中文约束）', () => {
    const zh = buildChatContext(base).system;
    expect(zh).toContain('一天最多两问');
    const en = buildChatContext({ ...base, locale: 'en' as Locale }).system;
    expect(en).toContain('At most two questions a day');
    expect(en).toContain('When he answers badly');
    const tw = buildChatContext({ ...base, locale: 'zh-TW' as Locale }).system;
    expect(tw).toContain('一天最多兩問');
    const ja = buildChatContext({ ...base, locale: 'ja' as Locale }).system;
    expect(ja).toContain('一日に質問は二つまで');
  });
});

describe('validateDigest（会话摘要结构校验）', () => {
  it('合法摘要通过，pinned 过滤非法 kind/空文本并截 3 条', () => {
    const digest = validateDigest({
      summary: '用户谈到买外套后内疚三天，背后是「不配」的旧声音。',
      pinned: [
        { kind: 'taboo', text: '别提我爸' },
        { kind: 'nonsense', text: 'x' },
        { kind: 'promise', text: '下周和老板谈加薪' },
        { kind: 'open', text: '' },
        { kind: 'open', text: '第四条不要' },
      ],
    });
    expect(digest?.summary).toContain('内疚');
    // 合法 pinned = taboo + promise + 第四条(open)；非法 kind、空文本被滤掉，最多 3 条
    expect(digest?.pinned.map((p) => p.kind)).toEqual(['taboo', 'promise', 'open']);
  });

  it('摘要过短/缺失/非字符串 → null（宁缺勿错）', () => {
    expect(validateDigest({ summary: '太短', pinned: [] })).toBeNull();
    expect(validateDigest({})).toBeNull();
    expect(validateDigest('hello')).toBeNull();
  });
});

describe('DIGEST_SYSTEM（会话摘要人称）', () => {
  // 摘要会原样出现在成长历程「那天聊到的」里念给本人听：必须第二人称。
  // 断言切在红线之前——指令正文本身就不许拿第三人称当行文样板，模型会照抄。
  it('zh 正文用「你」而不是「用户/他」，并带第三人称红线', () => {
    for (const locale of ['zh-CN', 'zh-TW'] as const) {
      const zh = locale === 'zh-CN';
      const sys = DIGEST_SYSTEM[locale];
      const brief = sys.slice(0, sys.indexOf(zh ? '红线：' : '紅線：'));
      expect(brief, locale).toContain(zh ? '你说了什么' : '你說了什麼');
      expect(brief, locale).not.toContain('用户说了什么');
      expect(brief, locale).not.toContain('用戶說了什麼');
      expect(sys, locale).toContain(zh ? '第三人称' : '第三人稱');
    }
  });

  it('en 正文对本人说 you，不写 the user', () => {
    const brief = DIGEST_SYSTEM.en.slice(0, DIGEST_SYSTEM.en.indexOf('Red line:'));
    expect(brief).toContain('what you said and felt');
    expect(brief).not.toContain('what the user said');
    expect(DIGEST_SYSTEM.en).toContain('second person');
  });

  it('ja 正文用「あなた」', () => {
    expect(DIGEST_SYSTEM.ja).toContain('あなたが何を言い');
    expect(DIGEST_SYSTEM.ja).not.toContain('ユーザーが何を言い');
  });
});
