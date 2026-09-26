'use client';

// 推送点按桥（docs/11 M2）：壳里点通知 → 通知 payload 里的 url → 站内跳转。
// 纯浏览器里 window.Capacitor 不存在，一次判断即返回——不加载插件、不发请求。
// url 只认本站 https 地址：payload 来自我们自己的调度器，但守着不放进相对路径/Javascript:。
import { useEffect } from 'react';

export default function PushTapBridge() {
  useEffect(() => {
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    if (typeof cap?.isNativePlatform !== 'function' || !cap.isNativePlatform()) return;
    let cleanup: (() => void) | null = null;
    void (async () => {
      try {
        const { PushNotifications } = await import('@capacitor/push-notifications');
        const listener = await PushNotifications.addListener(
          'pushNotificationActionPerformed',
          (action) => {
            const data = (action.notification.data ?? {}) as { url?: unknown };
            if (typeof data.url === 'string' && data.url.startsWith('https://')) {
              window.location.assign(data.url);
            }
          },
        );
        cleanup = () => void listener.remove();
      } catch {
        // 壳版本过旧/插件缺失：推送点按退化为"打开 app"，可接受
      }
    })();
    return () => cleanup?.();
  }, []);
  return null;
}
