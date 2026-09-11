// 表单校验纯函数：无 Node 依赖，服务端路由与客户端弹窗共用
// （不能放进 auth.ts——那里引了 crypto/fs，客户端 import 会打包失败）

export function validateUsername(username: string): string | null {
  if (!username) return '用户名不能为空';
  if (username.length < 3 || username.length > 20) return '用户名需 3~20 个字符';
  if (!/^[a-zA-Z0-9_一-龥]+$/.test(username)) {
    return '用户名只能包含中文、英文、数字或下划线';
  }
  return null; // 合法
}

// 邮箱校验：够用的宽松规则（本地@域名），具体可达性由验证邮件/重置邮件兜底
export function validateEmail(email: string): string | null {
  if (!email) return '邮箱不能为空';
  if (email.length > 254) return '邮箱过长';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '邮箱格式不正确';
  return null; // 合法
}

export function validatePassword(password: string): string | null {
  if (!password) return '密码不能为空';
  if (password.length < 6) return '密码至少 6 位';
  return null;
}
