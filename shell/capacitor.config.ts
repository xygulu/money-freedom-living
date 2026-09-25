import type { CapacitorConfig } from '@capacitor/cli';

/*
 * 远端壳（docs/11）：页面全部来自线上站点，壳只承载原生能力（推送、安全区、上架合规件）。
 * 页面改动即时生效、免重新提审；只有原生桥改动才需要发新版本。
 * 本目录与 Next.js 应用完全隔离：独立 package.json，root pnpm 不感知。
 */
const config: CapacitorConfig = {
  // bundle id 取产品域反写；改名窗口 = Apple 门户建 App ID 之前（docs/11 §7）
  appId: 'ink.miller.honghong',
  // 展示名占位——产品名（尤其中英文取舍）待用户拍板（docs/02 定位）
  appName: '一辈子不愁钱的活法',
  webDir: 'www', // 远端壳：仅占位；真实页面在线上
  server: {
    // 线上站点（P1-1 切生产 build 后 URL 不变，只是服务方式变）
    url: 'https://honghong.miller.ink',
    // 允许线上 origin 使用 Capacitor 桥（没有它 PushNotifications 在远端页面里不可用）
    allowNavigation: ['honghong.miller.ink'],
  },
  ios: {
    // 内容不再由 WebView 自动内缩——安全区已在 web 侧用 env(safe-area-inset-*) 处理（2a84c77）
    contentInset: 'never',
  },
  plugins: {
    // 前台收到推送时的展示形态；权限请求时机在 web 侧控制（首次「今天这一步」之后，docs/11 M2）
    PushNotifications: {
      presentationOptions: ['badge', 'alert', 'sound'],
    },
  },
};

export default config;
