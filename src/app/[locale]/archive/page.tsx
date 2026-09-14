// 前台改造（70-2 A3）· 一存档：聚合页（仅聚合既有页面，不产生新数据）。
//
// 入口路径：/journey-new 顶栏右上"存档"按钮 / `/[locale]/archive`。
//
// 结构（§A3）：
//   - 我走过的路 → /road
//   - 我说过的话 → /chat/history
//   - 我的镜子（画像） → /portrait
//   - 我写过的信 → /letters
//   - 写信给以后的我 → /letters/new（若有路由；否则降级 /letters）
//   - 设置与账号 → /me
//
// 在聚合页底部"设置"段落里挂 VersionSwitch（界面）+ ThemeSwitch（调性），
// 主题切换仅靠前端 data-scene-theme 属性；无持久化（与现有"无 cookie 即 plain"对齐）。

import { notFound } from 'next/navigation';
import { enabledLocales, isLocale } from '@/i18n/config';
import { getDict } from '@/i18n/get-dict';
import { getUiVersion } from '@/lib/ui-version';
import ArchiveList from '@/components/ArchiveList';
import VersionSwitch from '@/components/VersionSwitch';
import ThemeSwitch from '@/components/ThemeSwitch';
import styles from './archive.module.css';

export const dynamic = 'force-dynamic';

export default async function ArchivePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();

  const dict = getDict(locale);
  const uiVersion = await getUiVersion();

  return (
    <div className={styles.archive}>
      <h2>{dict.archivePage.title}</h2>
      <p className={styles.lead}>{dict.archivePage.sub}</p>

      <ArchiveList
        locale={locale}
        rows={dict.archivePage.rows}
        // 写信路由可能不存在（取决于产品上线批次），降级到 letters 列表页
        // 当前项目里 /letters/new 不存在（letters 路由只有列表 + 单封信），所以统一指 /letters
        writeHref={`/${locale}/letters`}
      />

      {/* 设置段落 */}
      <section className={styles.setgroup} data-setgroup="settings">
        <p className={styles.lab}>{dict.archivePage.settingsGroup.versionLabel}</p>
        <VersionSwitch
          locale={locale}
          current={uiVersion}
          labels={dict.archivePage.versions}
        />

        <p className={styles.lab} style={{ marginTop: 18 }}>
          {dict.archivePage.settingsGroup.themeLabel}
        </p>
        <ThemeSwitch labels={dict.archivePage.themes} />

        <p className={styles.mini}>
          <a href={`/${locale}/me`} className={styles.backlink}>
            {dict.archivePage.rows.setting} →
          </a>
        </p>
      </section>
    </div>
  );
}
