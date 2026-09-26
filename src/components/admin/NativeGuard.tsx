'use client';

// 壳内导航黑名单的第二道闸（docs/11 M1）：管理后台不进 iOS 壳。
// 第一道闸是服务端的（非白名单 404）；这一道拦的是「管理员本人在壳里打开了 /admin」
// ——后台是桌面工具，别让它出现在手机 app 的 WebView 里。
// 纯浏览器（无 Capacitor 全局）一次判断即返回。
import { useEffect } from 'react';

export default function NativeGuard() {
  useEffect(() => {
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    if (typeof cap?.isNativePlatform === 'function' && cap.isNativePlatform()) {
      window.location.replace('/');
    }
  }, []);
  return null;
}
