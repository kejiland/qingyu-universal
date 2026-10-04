/* ============================================================
 * 本地磁盘存储适配器（对象存储的可选替代）
 * ------------------------------------------------------------
 * 未配置 S3 时，媒体 / 音乐 / 站点备份落盘到 DATA_DIR/uploads，
 * 通过应用自身的签名上传端点完成「浏览器直传」：
 *   POST /api/media/upload-url → 返回 /api/local-upload?key=…&sig=… 的 PUT 地址
 *   PUT  /api/local-upload?…   → 校验签名与有效期后写入磁盘
 *   公开访问 /media/<file>、/music/<file>、/og/<file>（支持 Range）
 * 配置了 S3（R2 / MinIO / AWS）后本适配器自动让位，仍走原生 SigV4 直传。
 * ============================================================ */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { LocalStorageLike, WorkerEnv } from '../types.js';

/** 允许写入/读取的对象前缀——白名单之外一律拒绝，避免任意路径写入。 */
const ALLOWED_PREFIXES = ['media/', 'music/', 'backups/', 'og/'] as const;

const b64url = (input: Uint8Array | string): string =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface LocalStorageOptions {
  uploadDir: string;
  secret: string;
  /** 对外基地址：用于生成浏览器可直接 PUT 的绝对地址。 */
  baseUrl: string;
}

export class LocalStorage implements LocalStorageLike {
  readonly uploadDir: string;
  readonly #secret: string;
  readonly #baseUrl: string;

  constructor(options: LocalStorageOptions) {
    this.uploadDir = options.uploadDir;
    this.#secret = options.secret;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    for (const prefix of ALLOWED_PREFIXES) {
      fs.mkdirSync(path.join(this.uploadDir, prefix), { recursive: true });
    }
  }

  #sign(method: string, key: string, expires: number, contentType: string): string {
    const payload = [method, key, String(expires), contentType || ''].join('\n');
    return b64url(crypto.createHmac('sha256', this.#secret).update(payload).digest());
  }

  /** 生成上传地址（与 S3 预签名 URL 同形：一个可直接 PUT 的绝对地址）。 */
  async presignPut(_env: WorkerEnv, key: string, expiresSec?: number, _bucket?: string, contentType?: string): Promise<string> {
    const ttl = Number(expiresSec) || 3600;
    const expires = Math.floor(Date.now() / 1000) + ttl;
    const type = contentType ?? '';
    const params = new URLSearchParams({
      key,
      exp: String(expires),
      ct: type,
      sig: this.#sign('PUT', key, expires, type)
    });
    return `${this.#baseUrl}/api/local-upload?${params.toString()}`;
  }

  /** 生成私有读取地址（备份对象使用，需签名）。 */
  async presignGet(_env: WorkerEnv, key: string, expiresSec?: number, _bucket?: string): Promise<string> {
    const ttl = Number(expiresSec) || 900;
    const expires = Math.floor(Date.now() / 1000) + ttl;
    const params = new URLSearchParams({
      key,
      exp: String(expires),
      sig: this.#sign('GET', key, expires, '')
    });
    return `${this.#baseUrl}/api/local-download?${params.toString()}`;
  }

  async deleteObject(_env: WorkerEnv, key: string): Promise<boolean> {
    const target = this.resolve(key);
    if (!target) return false;
    await fsp.rm(target, { force: true });
    await fsp.rm(`${target}.meta`, { force: true });
    return true;
  }

  /** 校验上传/下载地址的签名与有效期（常量时间比较，避免时序侧信道）。 */
  verify(method: string, key: string, expires: string, contentType: string, signature: string): boolean {
    if (!key || !expires || !signature) return false;
    if (Number(expires) * 1000 < Date.now()) return false;
    const expected = Buffer.from(this.#sign(method, key, Number(expires), contentType));
    const given = Buffer.from(String(signature));
    if (expected.length !== given.length) return false;
    return crypto.timingSafeEqual(expected, given);
  }

  /** 把 key 解析为磁盘路径；前缀不合法或越界时返回 null。 */
  resolve(key: string): string | null {
    const clean = String(key ?? '').replace(/^\/+/, '');
    if (!clean || clean.includes('..')) return null;
    if (!ALLOWED_PREFIXES.some((prefix) => clean.startsWith(prefix))) return null;
    const target = path.join(this.uploadDir, clean);
    const relative = path.relative(this.uploadDir, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return target;
  }

  /** 公开对象（/media/*、/music/*、/og/*）对应的磁盘路径。 */
  resolvePublic(pathname: string): string | null {
    const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
    if (!relative || relative.split('/').includes('..')) return null;
    const target = path.join(this.uploadDir, relative);
    const within = path.relative(this.uploadDir, target);
    if (within.startsWith('..') || path.isAbsolute(within)) return null;
    return target;
  }

  /** 读取上传时记录的 Content-Type（用于公开读取时回写正确 MIME）。 */
  async readMeta(filePath: string): Promise<string> {
    return fsp.readFile(`${filePath}.meta`, 'utf8').catch(() => '');
  }
}

export function createLocalStorage(options: LocalStorageOptions): LocalStorage {
  return new LocalStorage(options);
}