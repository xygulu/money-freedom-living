'use client';

import { createAuthClient } from 'better-auth/react';
import { usernameClient } from 'better-auth/client/plugins';

// Better Auth 客户端：与 src/lib/auth.ts 的服务端插件配置对应
// （usernameClient 提供 signIn.username / signUp.email 的 username 字段）
export const authClient = createAuthClient({
  plugins: [usernameClient()],
});
