// 前台改造（70-2 A3）· 一存档：聚合页（仅聚合既有页面，不产生新数据）。
//
// 入口路径：/journey-new 顶栏右上"存档"按钮 / `/[locale]/archive`。
//
// 结构（§A3 + 用户 2026-09-14 加固）：
//   - 我走过的路 → /road
//   - 我说过的话 → /chat/history
//   - 我的镜子（画像） → /portrait
//   - 我写过的信 → /letters
//   - 写信给以后的我 → /letters/new（若有路由；否则降级 /letters）
//   - 设置与账号 → /me  账号段下三行：邮件与通知偏好 / 导出·删除 / 语言·恢复码·会员 + 登出
//
// 在聚合页底部"设置"段落里挂 VersionSwitch（界面）+ ThemeSwitch（调性），
// 主题切换仅靠前端 data-scene-theme 属性；无持久化（与现有"无 cookie 即 plain"对齐）。

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { enabledLocales, isLocale } from '@/i18n/config';
import { getDict } from '@/i18n/get-dict';
import { getUiVersion, journeyHrefFor, withJourneyHref } from '@/lib/ui-version';
import { requireSignedIn } from '@/lib/identity';
import ArchiveList from '@/components/ArchiveList';
import VersionSwitch from '@/components/VersionSwitch';
import ThemeSwitch from '@/components/ThemeSwitch';
import SignOutButton from '@/components/SignOutButton';
import styles from './archive.module.css';

export const dynamic = 'force-dynamic';

export default async function ArchivePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();

  // 访客闸（用户 2026-09-14 拍板：访客 = 只能做金钱关系测试）
  await requireSignedIn(locale, `/${locale}/archive`);

  const uiVersion = await getUiVersion();
  // 注入按当前 ui_version 分流的 journeyHref
  const dict = withJourneyHref(getDict(locale), locale, uiVersion);
  // 切版本按钮需要"另一版本"的 href——用本地 helper 双算
  const journeyHrefByVersion = {
    new: journeyHrefFor(locale, 'new'),
    classic: journeyHrefFor(locale, 'classic'),
  } as const;

  return (
    <div className={styles.archive}>
      <p className={styles.mini}>
        <Link href={dict.nav.journeyHref} className={styles.backlink} data-back-to-journey>
          ← {dict.archivePage.backToJourney}
        </Link>
      </p>
      <h2>{dict.archivePage.title}</h2>
      <p className={styles.lead}>{dict.archivePage.sub}</p>

      <ArchiveList
        locale={locale}
        rows={dict.archivePage.rows}
        // 写信路由可能不存在（取决于产品上线批次），降级到 letters 列表页
        // 当前项目里 /letters/new 不存在（letters 路由只有列表 + 单封信），所以统一指 /letters
        writeHref={`/${locale}/letters`}
      />

      {/* 第一段：界面 */}
      <section className={styles.setgroup} data-setgroup="version">
        <p className={styles.lab}>{dict.archivePage.settingsGroup.versionLabel}</p>
        <VersionSwitch
          locale={locale}
          current={uiVersion}
          labels={dict.archivePage.versions}
          journeyHrefByVersion={journeyHrefByVersion}
        />
      </section>

      {/* 第二段：调性 */}
      <section className={styles.setgroup} data-setgroup="theme">
        <p className={styles.lab}>{dict.archivePage.settingsGroup.themeLabel}</p>
        <ThemeSwitch labels={dict.archivePage.themes} />
      </section>

      {/* 第三段：设置与账号（账号段下三行 + 登出）——按原型 §A3 + 用户加固 */}
      <section className={styles.setgroup} data-setgroup="account">
        <p className={styles.lab} data-account-label>
          {dict.archivePage.settingsGroup.accountLabel}
        </p>

        <ul className={styles.list} data-account-rows>
          <li className={styles.arow} data-account-row="emailNotif">
            <Link href={`/${locale}/me#notif`} className={styles.link}>
              <span className={styles.t}>{dict.archivePage.settingsGroup.emailNotif}</span>
              <span className={styles.arrow}>›</span>
            </Link>
            <p className={styles.hint}>{dict.archivePage.settingsGroup.emailNotifHint}</p>
          </li>
          <li className={styles.arow} data-account-row="exportDelete">
            <Link href={`/${locale}/me#delete`} className={styles.link}>
              <span className={styles.t}>{dict.archivePage.settingsGroup.exportDelete}</span>
              <span className={styles.arrow}>›</span>
            </Link>
          </li>
          <li className={styles.arow} data-account-row="langRecoveryVip">
            <Link href={`/${locale}/me`} className={styles.link}>
              <span className={styles.t}>{dict.archivePage.settingsGroup.langRecoveryVip}</span>
              <span className={styles.arrow}>›</span>
            </Link>
          </li>
        </ul>

        {/* 登出：硬闸后此处永远渲染（70-2 加固产物保留） */}
        <div className={styles.signoutWrap}>
          <SignOutButton
            locale={locale}
            labels={{
              btn: dict.me.signOut,
              confirm: dict.me.signOutConfirm,
              cancel: dict.me.deleteCancel,
            }}
          />
        </div>
      </section>
    </div>
  );
}
