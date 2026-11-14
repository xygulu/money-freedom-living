'use client';

// PWA 注册（2026-11-14）：注册 service worker —— 浏览器「添加到主屏幕」的安装条件。
//
// 纪律：SW 本身在 public/sw.js，**不缓存任何含个人数据的响应**（导航一律走网络）。
// 这里只做注册 + 更新提示的钩子，失败静默——注册不上只是没有「添加到主屏幕」，
// 不该以任何形式打扰用户（全站不展示红字口径）。
import { useEffect } from 'react';

export default function PwaRegister() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        // 注册失败（老浏览器/隐私模式/HTTPS 缺失）静默放弃——不影响使用
      });
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
