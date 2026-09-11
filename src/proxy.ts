import { NextRequest, NextResponse } from 'next/server';
import { defaultLocale, enabledLocales, isLocale, type Locale } from '@/i18n/config';

const LOCALE_COOKIE = 'mfl_locale';

/** 只放行 API、Next 内部资源与带扩展名的静态文件 */
function isPassthrough(pathname: string): boolean {
  return (
    pathname.startsWith('/api') ||
    pathname.startsWith('/_next') ||
    pathname.includes('.') ||
    pathname === '/favicon.ico'
  );
}

/** 从 Accept-Language 解析可用 locale（zh 系按简繁分流；不可用语言落回英文） */
function localeFromHeader(header: string | null): Locale {
  const preferences = header
    ?.split(',')
    .map((part) => {
      const [tag, q] = part.trim().split(';q=');
      return { tag: tag.toLowerCase(), q: q ? parseFloat(q) : 1 };
    })
    .sort((a, b) => b.q - a.q) ?? [];

  for (const { tag } of preferences) {
    if (tag.startsWith('zh')) {
      if (/hant|tw|hk|mo/.test(tag)) return pick('zh-TW');
      if (/hans|cn|sg/.test(tag)) return pick('zh-CN');
      return pick('zh-CN');
    }
    if (tag.startsWith('ja')) return pick('ja');
    if (tag.startsWith('en')) return pick('en');
  }
  return defaultLocale;

  // 不可用语言（转正前）回落英文
  function pick(locale: Locale): Locale {
    return enabledLocales.includes(locale) ? locale : defaultLocale;
  }
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPassthrough(pathname)) return NextResponse.next();

  const [, firstSegment] = pathname.split('/');

  // 已带 locale 前缀：同步 cookie 后放行；未开放语言回落英文
  if (isLocale(firstSegment)) {
    if (!enabledLocales.includes(firstSegment)) {
      const rest = pathname.slice(firstSegment.length + 1) || '';
      return NextResponse.redirect(new URL(`/${defaultLocale}${rest ? `/${rest}` : ''}`, request.url));
    }
    const response = NextResponse.next();
    if (request.cookies.get(LOCALE_COOKIE)?.value !== firstSegment) {
      response.cookies.set(LOCALE_COOKIE, firstSegment, { path: '/', maxAge: 60 * 60 * 24 * 365 });
    }
    return response;
  }

  // 无前缀：cookie → Accept-Language → 默认
  const cookieLocale = request.cookies.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(cookieLocale) && enabledLocales.includes(cookieLocale)
    ? cookieLocale
    : localeFromHeader(request.headers.get('accept-language'));

  return NextResponse.redirect(new URL(`/${locale}${pathname === '/' ? '' : pathname}`, request.url));
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
