// 壳内推送注册（docs/11 M2）：只在 Capacitor 原生环境里动作，纯浏览器零调用零请求。
//
// 时机纪律：只在首次「今天这一步」提交成功之后调用（ActCard submitCommit）——
// 绝不在启动时弹权限框（docs/11 M2 拍板；启动即弹是推送权限拒答率最高的一种姿势）。
//
// 幂等：每个页面会话最多走一次流程；token 上报本身无脑幂等（服务端按 token 去重刷新）。
// 系统拒了就是没同意：不追问、不引导、下一会话也只 checkPermissions 一次。
// 任何异常都静默——推送永远不值得打断用户的当下。
let asked = false;

function nativeShell(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return typeof cap?.isNativePlatform === 'function' && cap.isNativePlatform();
}

export async function maybeRegisterPush(): Promise<void> {
  if (asked || !nativeShell()) return;
  asked = true;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    const current = await PushNotifications.checkPermissions();
    let status = current.receive;
    if (status !== 'granted') {
      status = (await PushNotifications.requestPermissions()).receive;
    }
    if (status !== 'granted') return;
    await PushNotifications.addListener('registration', (token) => {
      void fetch('/api/me/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.value, platform: 'ios' }),
      }).catch(() => null);
    });
    await PushNotifications.addListener('registrationError', (error) => {
      console.warn('[push] registration failed:', error.error ?? 'unknown');
    });
    await PushNotifications.register();
  } catch (error) {
    console.warn('[push] register skipped:', error instanceof Error ? error.message : error);
  }
}
