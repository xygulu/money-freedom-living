import { describe, it, expect } from 'vitest';
import { pickTouchNode, pickEcho, composeTouch, unsubUrl, isDeliverableEmail, TOUCH_NODES, MIN_GAP_DAYS } from '../lib/touch';
import type { GrowthProfile } from '../lib/profile';
import en from '../i18n/messages/en.json';
import zhCN from '../i18n/messages/zh-CN.json';
import zhTW from '../i18n/messages/zh-TW.json';
import ja from '../i18n/messages/ja.json';
import type { Dict } from '../i18n/get-dict';

// 这一组守的是 docs/05 §9 的三条硬约束：
// 不能天天发、未 opt-in 一封都不发、句式只许「它记得你说过 X」。
// 最后一条是红线里最容易被慢慢磨掉的那条 —— 所以四语模板逐句过禁语表。

const DAY = 86_400_000;
const ago = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const agoDate = (n: number) => ago(n).slice(0, 10);

function profileOf(over: Partial<GrowthProfile> = {}): GrowthProfile {
  return {
    user_key: 'u:test',
    locale: 'zh-CN',
    portrait: null,
    concerns: [],
    stage: 1,
    stage_started_at: ago(30),
    pinned: [],
    memories: [],
    experiments: [],
    letters: [],
    stamps: [],
    evolution: {},
    assessment: {
      pending: null, confirmed: null, confirmedAt: null, dismissedAt: null,
      generatingAt: null, proposedSeenAt: null, previousConfirmed: null,
      changeList: null, changeListLockAt: null,
    },
    created_at: ago(30),
    dailySeen: [],
    payday: null,
    total_active_days: 3,
    last_active_date: agoDate(10),
    books: [],
    threads: {},
    touch: { emailOptIn: true, unsubToken: 'tok-1' },
    ...over,
  } as GrowthProfile;
}

describe('pickTouchNode：每一道闸都是"不发"的理由', () => {
  it('没 opt-in → 一封都不发（合规第一条）', () => {
    expect(pickTouchNode(profileOf({ touch: { emailOptIn: false, unsubToken: 'x' } }))).toBeNull();
    expect(pickTouchNode(profileOf({ touch: {} }))).toBeNull();
  });

  it('没有退订凭据 → 不发（宁可漏发，也不发一封退不掉的信）', () => {
    expect(pickTouchNode(profileOf({ touch: { emailOptIn: true } }))).toBeNull();
  });

  it('人昨天还在 → 不发（邮件是召回，不是日活引擎）', () => {
    expect(pickTouchNode(profileOf({ last_active_date: agoDate(0) }))).toBeNull();
    expect(pickTouchNode(profileOf({ last_active_date: agoDate(1) }))).toBeNull();
  });

  it('刚发过 → 两封之间留足间隔，不连着轰', () => {
    const justSent = profileOf({ touch: { emailOptIn: true, unsubToken: 't', lastSentAt: ago(MIN_GAP_DAYS - 1) } });
    expect(pickTouchNode(justSent)).toBeNull();
  });

  it('间隔门槛不能大于 D3→D7 的四天，否则 D7 会被推迟到第八天以后', () => {
    expect(MIN_GAP_DAYS).toBeLessThanOrEqual(4);
    // 第 3 天发了 D3，第 7 天整到 D7：门槛正好卡在边界上，这一封必须准时
    const p = profileOf({
      created_at: ago(7),
      last_active_date: agoDate(4),
      touch: { emailOptIn: true, unsubToken: 't', sentNodes: { D3: ago(4) }, lastSentAt: ago(4) },
    });
    expect(pickTouchNode(p)).toBe('D7');
  });

  it('D3 的门槛单独放宽：第二天露了一面，第三天那封照发', () => {
    // D3 是冲着"第三天断崖"去的。要求连着两天不来，等于把它唯一想接住的那个人错过
    const p = profileOf({ created_at: ago(3), last_active_date: agoDate(1) });
    expect(pickTouchNode(p)).toBe('D3');
    // 今天还在的人不需要召回——放宽也只放宽到这儿为止
    expect(pickTouchNode(profileOf({ created_at: ago(3), last_active_date: agoDate(0) }))).toBeNull();
  });

  it('后面的节点仍要求离开满两天（别打扰还在的人）', () => {
    expect(pickTouchNode(profileOf({ created_at: ago(7), last_active_date: agoDate(1) }))).toBeNull();
    expect(pickTouchNode(profileOf({ created_at: ago(7), last_active_date: agoDate(2) }))).toBe('D7');
  });

  it('到了节点就发；到期的挑最大的那个，不补发一串旧信', () => {
    expect(pickTouchNode(profileOf({ created_at: ago(3) }))).toBe('D3');
    expect(pickTouchNode(profileOf({ created_at: ago(40) }))).toBe('D30');
  });

  it('还没到第一个节点 → 什么都不发', () => {
    expect(pickTouchNode(profileOf({ created_at: ago(1) }))).toBeNull();
  });

  it('发过的节点不再发（重发防护不是靠"脚本不重复跑"）', () => {
    const sentAll = Object.fromEntries(TOUCH_NODES.map((n) => [`D${n}`, ago(20)]));
    expect(pickTouchNode(profileOf({ created_at: ago(200), touch: { emailOptIn: true, unsubToken: 't', sentNodes: sentAll } }))).toBeNull();
  });

  it('发过 D3 之后，下一个到期节点照常轮到', () => {
    const p = profileOf({ created_at: ago(9), touch: { emailOptIn: true, unsubToken: 't', sentNodes: { D3: ago(6) } } });
    expect(pickTouchNode(p)).toBe('D7');
  });

  it('从没活跃过（last_active_date 为空）也算"不在这儿"，照样召回', () => {
    expect(pickTouchNode(profileOf({ last_active_date: null, created_at: ago(8) }))).toBe('D7');
  });

  it('第 40 天才打开来信 → 收到 D30 就够了，之后不补发 D21/D14/D7 一串旧信', () => {
    const late = profileOf({ created_at: ago(40) });
    expect(pickTouchNode(late)).toBe('D30');
    const afterD30 = profileOf({
      created_at: ago(46),
      touch: { emailOptIn: true, unsubToken: 't', sentNodes: { D30: ago(6) }, lastSentAt: ago(6) },
    });
    expect(pickTouchNode(afterD30)).toBeNull(); // 往前走：下一封要等到 D66
    const atD66 = profileOf({
      created_at: ago(70),
      touch: { emailOptIn: true, unsubToken: 't', sentNodes: { D30: ago(30) }, lastSentAt: ago(30) },
    });
    expect(pickTouchNode(atD66)).toBe('D66');
  });
});

describe('pickEcho：引用的必须是他自己说过的话', () => {
  it('优先引用他写过的信（最近一封）', () => {
    const p = profileOf({
      letters: [
        { stage: 1, content: '早的那封', state: 'kept', aiReply: null, createdAt: ago(9) },
        { stage: 1, content: '晚的那封', state: 'kept', aiReply: null, createdAt: ago(2) },
      ],
    });
    expect(pickEcho(p)).toEqual({ text: '晚的那封', from: 'letter' });
  });

  it('没写过信就用命题线上的原话', () => {
    const p = profileOf({
      threads: {
        'self-worth': {
          firstSeenAt: ago(9), lastSeenAt: ago(9), depth: 'seen',
          evidence: [{ at: ago(9), bookId: 'money-freedom', source: 'assessment', ref: 'x', quote: '我不配' }],
        },
      },
    });
    expect(pickEcho(p)?.text).toBe('我不配');
  });

  it('什么都没说过 → 不引用，绝不编一句替他说', () => {
    expect(pickEcho(profileOf())).toBeNull();
  });

  it('信与命题线一起按时间排：三个月前的信不该压过昨天那句话', () => {
    const p = profileOf({
      letters: [{ stage: 1, content: '三个月前写的', state: 'kept', aiReply: null, createdAt: ago(90) }],
      threads: {
        'self-worth': {
          firstSeenAt: ago(90), lastSeenAt: ago(1), depth: 'seen',
          evidence: [{ at: ago(1), bookId: 'money-freedom', source: 'chat', ref: 'x', quote: '昨天说的' }],
        },
      },
    });
    expect(pickEcho(p)).toEqual({ text: '昨天说的', from: 'thread' });
  });

  it('反过来也一样：信更近就引用信', () => {
    const p = profileOf({
      letters: [{ stage: 1, content: '昨天写的', state: 'kept', aiReply: null, createdAt: ago(1) }],
      threads: {
        'self-worth': {
          firstSeenAt: ago(30), lastSeenAt: ago(30), depth: 'seen',
          evidence: [{ at: ago(30), bookId: 'money-freedom', source: 'chat', ref: 'x', quote: '一个月前说的' }],
        },
      },
    });
    expect(pickEcho(p)).toEqual({ text: '昨天写的', from: 'letter' });
  });
});

const DICTS: [string, Dict][] = [
  ['en', en as unknown as Dict],
  ['zh-CN', zhCN as unknown as Dict],
  ['zh-TW', zhTW as unknown as Dict],
  ['ja', ja as unknown as Dict],
];

// 禁语表（docs/05 §9.4）：左栏那些句式一个都不许出现在信里。
// 「你还没做 / 你已经 3 天没来 / 别忘了今天的练习」——这是催促、断签、欠账、评判。
const FORBIDDEN: Record<string, RegExp[]> = {
  en: [/haven'?t/i, /didn'?t (do|finish|come)/i, /don'?t forget/i, /forgot/i, /streak/i, /missed/i, /reminder/i, /\bdays? (since|without|away)\b/i, /keep it up/i, /back on track/i],
  zh: [/还没/, /忘了/, /别忘/, /打卡/, /断签/, /坚持/, /连续\s*\d/, /已经\s*\d+\s*天/, /天没/, /未完成/, /加油/, /该你/, /提醒你/],
  ja: [/忘れ/, /サボ/, /連続/, /日ぶり/, /続けま/, /頑張っ/, /リマインド/, /まだ.*ていません/],
};
const rulesFor = (locale: string) => (locale === 'en' ? FORBIDDEN.en : locale === 'ja' ? FORBIDDEN.ja : FORBIDDEN.zh);

describe('信的句式：只许「它记得你说过 X」，不许催促/断签/欠账/评判', () => {
  for (const [locale, dict] of DICTS) {
    it(`${locale}：七个节点的模板一句禁语都没有`, () => {
      const t = dict.touch;
      // 只查**信里会出现的字**。opt-in 说明里那句「没有打卡，没有断签」是红线的
      // 正面表述（在讲这儿没有这些东西），拿同一张表去扫它只会误伤——那句由下一条单独守。
      const all = [
        ...Object.values(t.letters as unknown as Record<string, { subject: string; body: string }>)
          .flatMap((l) => [l.subject, l.body]),
        t.bodyNoEcho, t.settingOn, t.settingOff, t.unsubDone,
      ].join('\n');
      const hits = rulesFor(locale).filter((re) => re.test(all)).map(String);
      expect(hits, `${locale} 里出现了禁语：${hits.join(', ')}`).toEqual([]);
    });

    it(`${locale}：opt-in 说明把"不勾也没代价"讲明白（不是把打卡挂出来当卖点）`, () => {
      const hint = dict.touch.optInHint;
      const negation = locale === 'en' ? /\bno\b/i : locale === 'ja' ? /ありません|変わりません/ : /没有|沒有|不影响|不影響/;
      expect(negation.test(hint), `${locale} 的 optInHint 缺少"这儿没有这些东西"的否定式`).toBe(true);
    });

    it(`${locale}：七个节点一个不少，每封都留了引用他原话的位置`, () => {
      const letters = dict.touch.letters as unknown as Record<string, { subject: string; body: string }>;
      expect(Object.keys(letters).sort()).toEqual(TOUCH_NODES.map((n) => `D${n}`).sort());
      for (const [node, l] of Object.entries(letters)) {
        expect(l.body, `${locale}/${node} 没有 {echo} 占位`).toContain('{echo}');
        expect(l.subject.length, `${locale}/${node} 标题为空`).toBeGreaterThan(0);
      }
    });
  }
});

describe('composeTouch：每封信都必须能退订', () => {
  const dict = zhCN as unknown as Dict;
  const base = 'https://example.test';

  it('信里带退订链接与回来的路，正文是他自己那句话', () => {
    const p = profileOf({ letters: [{ stage: 1, content: '我不敢报那个价', state: 'kept', aiReply: null, createdAt: ago(5) }] });
    const letter = composeTouch({ node: 'D7', profile: p, dict, locale: 'zh-CN', baseUrl: base })!;
    expect(letter.text).toContain('我不敢报那个价');
    expect(letter.text).toContain(unsubUrl(base, 'zh-CN', 'tok-1'));
    expect(letter.text).toContain(`${base}/zh-CN/journey`);
    // 回来的路带出处：他是从哪一封信回来的，journey 页据此记一笔 touch_return
    expect(letter.text).toContain('from=touch&node=D7');
    expect(letter.unsub).toBe(unsubUrl(base, 'zh-CN', 'tok-1'));
    expect(letter.html).toContain('unsubscribe?token=tok-1');
    expect(letter.subject.length).toBeGreaterThan(0);
  });

  it('没有 token → 压根组装不出这封信（退不掉的信发不出去）', () => {
    const p = profileOf({ touch: { emailOptIn: true } });
    expect(composeTouch({ node: 'D3', profile: p, dict, locale: 'zh-CN', baseUrl: base })).toBeNull();
  });

  it('他还没说过什么 → 走不引用的那版，不留空占位', () => {
    const letter = composeTouch({ node: 'D3', profile: profileOf(), dict, locale: 'zh-CN', baseUrl: base })!;
    expect(letter.text).not.toContain('{echo}');
    expect(letter.text).toContain('{title}'.replace('{title}', '')); // 占位已被替换
    expect(letter.text).toContain(dict.nav.journey);
  });

  it('原话太长会截断，但截断的是他的话，不是换成我的总结', () => {
    const long = '很长的一句'.repeat(60);
    const p = profileOf({ letters: [{ stage: 1, content: long, state: 'kept', aiReply: null, createdAt: ago(5) }] });
    const letter = composeTouch({ node: 'D14', profile: p, dict, locale: 'zh-CN', baseUrl: base })!;
    expect(letter.text).toContain('很长的一句很长的一句');
    expect(letter.text).toContain('…');
  });

  it('HTML 版里用户原话被转义（信里不许注入标签）', () => {
    const p = profileOf({ letters: [{ stage: 1, content: '<script>x</script>', state: 'kept', aiReply: null, createdAt: ago(5) }] });
    const letter = composeTouch({ node: 'D3', profile: p, dict, locale: 'zh-CN', baseUrl: base })!;
    expect(letter.html).not.toContain('<script>');
    expect(letter.html).toContain('&lt;script&gt;');
  });
});

describe('M11-E 收件地址：保留域名一封都不寄', () => {
  // 为什么这条值得一组测试：smoke 每跑一次就留下几个 `@smoke.test` 的账号，其中
  // 会有 opt-in 的。timer 装上之后要是真寄过去，就是一串硬退——退信率是发信域名的
  // 命根子，攒够了连真实用户的信都进不了收件箱。拦在本地是免费的，退信是全域名共担的。
  it('RFC 2606 保留 TLD 与 example 域一律不寄', () => {
    expect(isDeliverableEmail('m11-touch-ab12cd34@smoke.test')).toBe(false);
    expect(isDeliverableEmail('a@foo.invalid')).toBe(false);
    expect(isDeliverableEmail('a@localhost')).toBe(false);
    expect(isDeliverableEmail('a@box.localhost')).toBe(false);
    expect(isDeliverableEmail('a@example.com')).toBe(false);
    expect(isDeliverableEmail('a@Example.ORG')).toBe(false); // 大小写不是漏洞
  });

  it('长得不像地址的也不寄（没有 @ / 没有点 / 有空格）', () => {
    expect(isDeliverableEmail('nobody')).toBe(false);
    expect(isDeliverableEmail('@foo.com')).toBe(false);
    expect(isDeliverableEmail('a@')).toBe(false);
    expect(isDeliverableEmail('a@localdomain')).toBe(false);
    expect(isDeliverableEmail('a b@foo.com')).toBe(false);
  });

  it('真实地址照常寄——别把真人误伤了', () => {
    expect(isDeliverableEmail('xygulu@139.com')).toBe(true);
    expect(isDeliverableEmail('someone@gmail.com')).toBe(true);
    expect(isDeliverableEmail('a.b+tag@sub.miller.ink')).toBe(true);
    expect(isDeliverableEmail('人@例子.中国')).toBe(true); // 国际化域名不该被误杀
  });
});
