'use client';

// 前台改造（70-2 B3）· 镜像卡：提交后展示用户原话 + 陪伴者一句 echo + 「想多说两句」门。
//
// 70-2 加固（J 项）：echo 走前端分支硬编码（原型 line 532-534），不再调 close.receipt：
//   - firstLine 有内容  → "这句话和你以前说的不太一样…"
//   - firstLine 无内容  → "记下了。你今天走到这里…"
//
// - 顶部：你写的是「{firstLine || thought || 跳过了}」
// - 下方：陪伴者听到的是「{echo 前端分支硬编码}」
// - 「想多说两句」门 → /chat?start=1&door=1[&quote=<encoded thought/firstLine>]
// - 「改一下」按钮回到 act 段（mirror 状态清空）。
import Link from 'next/link';
import type { Dict } from '@/i18n/get-dict';
import type { MirrorState } from './NewJourneyView';
import styles from './MirrorCard.module.css';

interface Props {
  locale: string;
  dict: Dict;
  mirror: MirrorState;
  onEdit: () => void;
}

export default function MirrorCard({ locale, dict, mirror, onEdit }: Props) {
  const t = dict.newJourney;
  const userWrote = mirror.firstLine.trim() || mirror.thought.trim();

  // J 项：echo 走前端分支硬编码（原型 line 532-534），不再调 close.receipt
  // t3 = 是否有 firstLine
  const echo = mirror.firstLine.trim()
    ? '这句话和你以前说的不太一样……'
    : '记下了。你今天走到这里，已经够了。';

  // 门的 quote：用户原话或 thought；都没有就空（fallback 由 CompanionDoor 顶）
  const doorQuote = encodeURIComponent(userWrote);
  const doorHref = userWrote
    ? `/${locale}/chat?start=1&door=1&quote=${doorQuote}`
    : `/${locale}/chat?start=1&door=1`;

  return (
    <article className={styles.card} data-step="done">
      <p className={styles.eyebrow}>{t.doneEyebrow}</p>

      <section className={styles.block}>
        <p className={styles.blockLabel}>{t.mirrorQuote}</p>
        {userWrote ? (
          <blockquote className={styles.quote}>
            「{userWrote}」
          </blockquote>
        ) : (
          <p className={styles.skipped}>{t.noMirror}</p>
        )}
      </section>

      <section className={styles.block}>
        <p className={styles.blockLabel}>{t.mirrorEcho}</p>
        <p className={styles.echo}>{echo}</p>
      </section>

      <footer className={styles.footer}>
        <Link href={doorHref} className={styles.door} data-companion-door-link="">
          {dict.companion.doorLink} →
        </Link>
        <button type="button" onClick={onEdit} className={styles.edit}>
          改一下
        </button>
      </footer>

      <p className={styles.doneSub}>{t.doneSub}</p>
    </article>
  );
}
