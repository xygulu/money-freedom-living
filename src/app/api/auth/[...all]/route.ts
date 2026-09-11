import { auth } from '@/lib/auth';
import { toNextJsHandler } from 'better-auth/next-js';

// Better Auth catch-all：注册/登录/登出/会话等全部端点
// （/api/auth/sign-up/email、/api/auth/sign-in/username、/api/auth/sign-out、/api/auth/get-session …）
// 由 better-auth 托管，见 src/lib/auth.ts
export const { GET, POST } = toNextJsHandler(auth);
