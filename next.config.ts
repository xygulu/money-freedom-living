import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Next 16 dev 服务器默认只允许 localhost 请求 dev 资源（防跨源）。
  // 局域网 IP / miller.ink 反代访问时 /_next/static 全部 403 → 客户端 JS
  // 加载失败 → 页面看得到但任何交互都没反应。这里放行开发期访问来源。
  // （生产构建不受影响：这是 dev-only 配置）
  allowedDevOrigins: ['honghong.miller.ink', '*.miller.ink', '192.168.24.121'],
};

export default nextConfig;
