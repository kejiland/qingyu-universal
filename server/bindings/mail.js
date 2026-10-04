/* ============================================================
 * 邮件适配层
 * ------------------------------------------------------------
 * 上游只实现了 Resend（HTTPS API）。自托管场景更常见的是 SMTP，
 * 因此这里提供两种发信方式，并由 server/config.js 注入 env.MAIL_SEND：
 *   · SMTP（任意邮箱服务商 / 自建 Postfix）
 *   · Resend（保留原实现，作为云服务选项）
 * 仅依赖 node:net / node:tls，无第三方依赖。
 * ============================================================ */
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

function b64(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

/** 极简 SMTP 客户端：支持隐式 TLS(465) 与 STARTTLS(587)，AUTH PLAIN / LOGIN。 */
class SmtpClient {
  constructor(options) {
    this.host = options.host;
    this.port = Number(options.port || 587);
    this.user = options.user || '';
    this.pass = options.pass || '';
    this.secure = !!options.secure;
    this.timeoutMs = Number(options.timeoutMs || 20000);
    this.socket = null;
    this.buffer = '';
    this.waiters = [];
  }

  _attach(socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      this._drain();
    });
    socket.on('error', (error) => this._fail(error));
    socket.on('close', () => this._fail(new Error('SMTP 连接已关闭')));
  }

  _drain() {
    // 多行响应以「末行 4 位数字 + 空格」结束，逐条交给等待者。
    for (;;) {
      const lines = this.buffer.split('\r\n');
      let endIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (/^\d{3} /.test(lines[i])) { endIndex = i; break; }
      }
      if (endIndex < 0) return;
      const consumed = lines.slice(0, endIndex + 1).join('\r\n');
      this.buffer = lines.slice(endIndex + 1).join('\r\n');
      const waiter = this.waiters.shift();
      const code = Number(consumed.slice(0, 3));
      if (waiter) waiter({ code: code, text: consumed });
    }
  }

  _fail(error) {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }

  _reply() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SMTP 响应超时')), this.timeoutMs);
      this.waiters.push({
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
    });
  }

  async _command(line, expect) {
    this.socket.write(line + '\r\n');
    const res = await this._reply();
    if (expect && res.code !== expect) throw new Error('SMTP 命令失败：' + line.split(' ')[0] + ' → ' + res.text);
    return res;
  }

  async connect() {
    if (this.secure) {
      const socket = tls.connect({ host: this.host, port: this.port, servername: this.host });
      this._attach(socket);
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
        setTimeout(() => reject(new Error('SMTP TLS 连接超时')), this.timeoutMs);
      });
    } else {
      const socket = net.connect({ host: this.host, port: this.port });
      this._attach(socket);
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
        setTimeout(() => reject(new Error('SMTP 连接超时')), this.timeoutMs);
      });
    }
    const greeting = await this._reply();
    if (greeting.code !== 220) throw new Error('SMTP 未就绪：' + greeting.text);

    let ehlo = await this._command('EHLO qingyu.local');
    if (ehlo.code !== 250) ehlo = await this._command('HELO qingyu.local');
    const supportsStartTls = /\bSTARTTLS\b/i.test(ehlo.text);
    if (!this.secure && supportsStartTls) {
      await this._command('STARTTLS', 220);
      const upgraded = tls.connect({ socket: this.socket, servername: this.host });
      this.socket = null;
      this.buffer = '';
      this._attach(upgraded);
      await new Promise((resolve, reject) => {
        upgraded.once('secureConnect', resolve);
        upgraded.once('error', reject);
      });
      await this._command('EHLO qingyu.local');
    }
    if (this.user) await this._auth();
  }

  async _auth() {
    const mechs = /\bAUTH([^\r\n]*)/i.exec(this.buffer + '');
    const mechLine = mechs ? mechs[1] : '';
    if (/PLAIN/i.test(mechLine) || true) {
      const token = b64('\u0000' + this.user + '\u0000' + this.pass);
      const res = await this._command('AUTH PLAIN ' + token);
      if (res.code === 235) return;
    }
    await this._command('AUTH LOGIN', 334);
    await this._command(b64(this.user), 334);
    const res = await this._command(b64(this.pass));
    if (res.code !== 235) throw new Error('SMTP 认证失败：' + res.text);
  }

  async send(message) {
    await this._command('MAIL FROM:<' + message.from + '>', 250);
    for (const to of message.to) await this._command('RCPT TO:<' + to + '>', 250);
    await this._command('DATA', 354);
    const data = message.raw.replace(/\r?\n/g, '\r\n').replace(/\r\n\./g, '\r\n..');
    this.socket.write(data + '\r\n.\r\n');
    const res = await this._reply();
    if (res.code !== 250) throw new Error('SMTP 投递失败：' + res.text);
  }

  close() {
    try { this.socket && this.socket.end(); } catch (_) { /* ignore */ }
  }
}

function header(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function buildMime(from, to, subject, html, replyTo) {
  const boundary = 'qingyu-' + crypto.randomUUID();
  const lines = [
    'From: ' + header(from),
    'To: ' + header(to),
    'Subject: =?UTF-8?B?' + b64(header(subject)) + '?=',
    'MIME-Version: 1.0'
  ];
  if (replyTo) lines.push('Reply-To: ' + header(replyTo));
  lines.push(
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html).replace(/(.{76})/g, '$1\r\n'),
    '--' + boundary + '--'
  );
  return lines.join('\r\n');
}

function parseAddress(raw) {
  const value = String(raw || '').trim();
  const match = /<([^>]+)>/.exec(value);
  return (match ? match[1] : value).trim();
}

/** 统一的发信入口：env.MAIL_SEND(to, subject, html) */
export function createSmtpSender(config) {
  return async function sendEmail(to, subject, html) {
    const from = parseAddress(config.from);
    const client = new SmtpClient(config);
    try {
      await client.connect();
      await client.send({
        from: from,
        to: [parseAddress(to)],
        raw: buildMime(config.from, to, subject, html, config.replyTo)
      });
      return true;
    } finally {
      client.close();
    }
  };
}