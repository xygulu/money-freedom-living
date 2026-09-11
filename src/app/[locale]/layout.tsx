import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import '../globals.css';
import { enabledLocales, htmlLang, isLocale } from '@/i18n/config';
import { getDict } from '@/i18n/get-dict';

export const metadata: Metadata = {
  title: 'Money Freedom Living',
  description: 'A room of your own, for everything money makes you feel.',
};

export function generateStaticParams() {
  return enabledLocales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();

  const dict = getDict(locale);
  const tabs = [
    { href: `/${locale}/journey`, label: dict.nav.journey },
    { href: `/${locale}/chat`, label: dict.nav.chat },
    { href: `/${locale}/journal`, label: dict.nav.journal },
    { href: `/${locale}/me`, label: dict.nav.me },
  ];

  return (
    <html lang={htmlLang(locale)}>
      <body className="min-h-dvh antialiased">
        <div className="mx-auto flex min-h-dvh max-w-xl flex-col px-5">
          <main className="flex-1">{children}</main>

          <nav
            aria-label="Main"
            className="sticky bottom-0 -mx-5 mt-10 grid grid-cols-4 border-t border-line bg-paper/95 backdrop-blur"
          >
            {tabs.map((tab) => (
              <Link
                key={tab.href}
                href={tab.href}
                className="px-2 py-3 text-center text-sm text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
              >
                {tab.label}
              </Link>
            ))}
          </nav>
        </div>
      </body>
    </html>
  );
}
