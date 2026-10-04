/* ============================================================
 * 邮件适配层：SMTP（nodemailer）
 * ------------------------------------------------------------
 * 上游只实现了 Resend 的 HTTPS API。自托管场景更常见的是自己的 SMTP，
 * 因此这里用 nodemailer 提供发信能力，并通过 env.MAIL_SEND 注入，
 * 让上游的订阅确认 / 新文章通知走本地邮件服务（或任意第三方 SMTP）。
 *
 * 选用 nodemailer 而不是手写 SMTP：连接池、STARTTLS 协商、AUTH 机制
 * 回退、编码与 MIME 组装都是容易出错的细节，交给成熟库更稳妥。
 * ============================================================ */
import nodemailer, { type Transporter } from 'nodemailer';
import type { MailSender } from '../types.js';

export interface SmtpOptions {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  secure?: boolean;
  /** 发件人，形如 `博客 <noreply@example.com>` 或纯邮箱地址。 */
  from: string;
  replyTo?: string;
}

export interface SmtpSender {
  /** 供上游 env.MAIL_SEND 调用的发信函数。 */
  send: MailSender;
  /** 启动自检：连接并认证一次，配置错误在启动阶段就暴露。 */
  verify(): Promise<void>;
  close(): void;
}

function createTransport(options: SmtpOptions): Transporter {
  return nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure ?? false,
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
    ...(options.user ? { auth: { user: options.user, pass: options.pass ?? '' } } : {})
  });
}

export function createSmtpSender(options: SmtpOptions): SmtpSender {
  const transport = createTransport(options);

  const send: MailSender = async (to, subject, html) => {
    const info = await transport.sendMail({
      from: options.from,
      to,
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      subject,
      html
    });
    const rejected = info.rejected ?? [];
    if (rejected.length > 0) {
      throw new Error(`SMTP 拒收收件人：${rejected.map(String).join(', ')}`);
    }
    return true;
  };

  return {
    send,
    async verify() {
      await transport.verify();
    },
    close() {
      transport.close();
    }
  };
}