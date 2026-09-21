// 灯图几何（叶子模块，V0.2 批 A 期间从 stage.ts 拆出）：
// StageLampChart 是客户端组件，stage.ts 运行时依赖 content.ts（灯表/文案取自
// 内容层），C3 给 content.ts 引入 node:fs 后，客户端 import stage.ts 会把 fs
// 拉进浏览器 chunk，Turbopack 直接 panic（页面 500）。顶点布局是纯几何、与
// 内容层无关——搬到这里（零依赖），stage.ts re-export 保持测试侧 import 不动。

/**
 * 灯图顶点布局：n 盏灯在单位圆上均布（顶部起始、顺时针）——3 盏=三角、2 盏=
 * 上下两点。返回 0..1 的单位圆坐标（圆心 0.5/0.5、半径 0.5），渲染层再乘尺寸；
 * 外圈即「这个阶段应达的程度」（标准），点亮顶点的连线范围 = 用户现在的位置。
 * 纯函数，便于单测；n=0（阶段 4 无灯）返回空。
 */
export function lampChartPoints(n: number): { x: number; y: number }[] {
  if (n <= 0) return [];
  const start = -Math.PI / 2;
  return Array.from({ length: n }, (_, i) => {
    const angle = start + (i * 2 * Math.PI) / n;
    return { x: 0.5 + 0.5 * Math.cos(angle), y: 0.5 + 0.5 * Math.sin(angle) };
  });
}
