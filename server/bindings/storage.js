/* ============================================================
 * 本地磁盘存储适配器（S3 的可选替代）
 * ------------------------------------------------------------
 * 未配置 S3 时，媒体 / 音乐 / 站点备份落盘到 DATA_DIR/uploads，
 * 通过应用自身的签名上传端点完成「浏览器直传」：
 *   POST /api/media/upload-url → 返回 /api/local-upload?key=...&sig=... 的 PUT 地址
 *   PUT  /api/local-upload?... → 校验签名与有效期后写入磁盘
 *   公开访问 /media/<file>、/music/<file>（支持 Range，可拖动播放）
 * 配置了 S3（R2 / MinIO / AWS）后本适配器自动让位，仍走原生 SigV4 直传。
 * ============================================================ */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class LocalStorageBinding {
  constructor(options) {
    this.uploadDir = options.uploadDir;
    this.secret = options.secret;
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    fs.mkdirSync(path.join(this.uploadDir, 'media'), { recursive: true });
    fs.mkdirSync(path.join(this.uploadDir, 'music'), { recursive: true });
    fs.mkdirSync(path.join(this.uploadDir, 'backups'), { recursive: true });
    fs.mkdirSync(path.join(this.uploadDir, 'og'), { recursive: true });
  }

  sign(method, key, expires, contentType) {
    const payload = [method, key, String(expires), contentType || ''].join('\n');
    return b64url(crypto.createHmac('sha256', this.secret).update(payload).digest());
  }

  /** 生成上传地址（与 S3 预签名 URL 同形：一个可直接 PUT 的绝对地址）。 */
  async presignPut(env, key, expiresSec, bucket, contentType) {
    const ttl = Number(expiresSec) || 3600;
    const expires = Math.floor(Date.now() / 1000) + ttl;
    const type = contentType || '';
    const params = new URLSearchParams({
      key: key,
      exp: String(expires),
      ct: type,
      sig: this.sign('PUT', key, expires, type)
    });
    return this.baseUrl + '/api/local-upload?' + params.toString();
  }

  /** 生成私有读取地址（备份对象使用，需签名）。 */
  async presignGet(env, key, expiresSec, bucket) {
    const ttl = Number(expiresSec) || 900;
    const expires = Math.floor(Date.now() / 1000) + ttl;
    const params = new URLSearchParams({
      key: key,
      exp: String(expires),
      sig: this.sign('GET', key, expires, '')
    });
    return this.baseUrl + '/api/local-download?' + params.toString();
  }

  async deleteObject(env, key, bucket) {
    const target = this._resolve(key);
    if (!target) return false;
    await fsp.rm(target, { force: true });
    return true;
  }

  verify(method, key, expires, contentType, signature) {
    if (!key || !expires || !signature) return false;
    if (Number(expires) * 1000 < Date.now()) return false;
    const expected = this.sign(method, key, expires, contentType);
    const a = Buffer.from(String(signature));
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /** 校验并写入上传对象；key 必须落在允许的前缀内，防止任意路径写入。 */
  async save(key, body, contentType) {
    const target = this._resolve(key);
    if (!target) throw new Error('非法的对象 key');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const buffer = Buffer.from(await new Response(body).arrayBuffer());
    await fsp.writeFile(target, buffer);
    // 同时记录 Content-Type，供公开读取时回写正确的 MIME。
    if (contentType) await fsp.writeFile(target + '.meta', contentType, 'utf8').catch(() => {});
    return { key: key, size: buffer.length };
  }

  readPath(key) {
    return this._resolve(key);
  }

  async readMeta(filePath) {
    return fsp.readFile(filePath + '.meta', 'utf8').catch(() => '');
  }

  _resolve(key) {
    const clean = String(key || '').replace(/^\/+/, '');
    if (!clean || clean.includes('..')) return null;
    const allowed = ['media/', 'music/', 'backups/', 'og/'];
    if (!allowed.some((prefix) => clean.startsWith(prefix))) return null;
    const target = path.join(this.uploadDir, clean);
    const relative = path.relative(this.uploadDir, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return target;
  }
}

export function createLocalStorage(options) {
  return new LocalStorageBinding(options);
}