/**
 * Resend 邮件发送：用原生 fetch 调 Resend HTTPS API（无需引入 resend SDK）。
 *
 * Resend API：https://resend.com/docs/api-reference/emails/send-email
 * POST https://api.resend.com/emails
 *   Authorization: Bearer <RESEND_API_KEY>
 *   { from, to, subject, text?, html? }
 *
 * 凭证约束：RESEND_API_KEY 与 RESEND_FROM 必须都配，否则抛错（auth.ts 已用 env 守门）。
 */

export interface ResendEmail {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

export async function sendResendEmail(email: ResendEmail): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) {
    throw new Error('RESEND_API_KEY / RESEND_FROM 未配置（无法发邮件）');
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: email.to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    }),
  });
  if (!res.ok) {
    // 失败信息不回显凭证，只回显 HTTP 状态 + Resend body 摘要
    const body = await res.text();
    throw new Error(`Resend HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}