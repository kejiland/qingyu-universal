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
import type { AppDatabase } from '../types.js';

/** 允许写入/读取的对象前缀——白名单之外一律拒绝，避免任意路径写入。 */
const ALLOWED_PREFIXES = ['media/', 'music/', 'backups/', 'og/'] as const;

const b64url = (input: Uint8Array | string): string =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface LocalStorageOptions {
  uploadDir: string;
  secret: string;
  /** 服务端内部基地址；浏览器上传会改用同源相对地址。 */
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

  /** 生成上传地址；relative=true 时返回同源相对地址，供浏览器直传。 */
  async presignPut(_env: WorkerEnv, key: string, expiresSec?: number, _bucket?: string, contentType?: string, relative = false): Promise<string> {
    const ttl = Number(expiresSec) || 3600;
    const expires = Math.floor(Date.now() / 1000) + ttl;
    const type = contentType ?? '';
    const params = new URLSearchParams({
      key,
      exp: String(expires),
      ct: type,
      sig: this.#sign('PUT', key, expires, type)
    });
    const path = `/api/local-upload?${params.toString()}`;
    return relative ? path : `${this.#baseUrl}${path}`;
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

const LOCAL_OBJECT_PATH = /^\/(media|music|og)\//;

function isLocalOrSiteHost(hostname: string, siteUrl: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === '0.0.0.0') {
    return true;
  }
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return true;
  }
  try {
    return new URL(siteUrl).hostname.toLowerCase() === host;
  } catch {
    return false;
  }
}

/** 把历史遗留的绝对本地上传地址改回根相对地址，避免绑定 WSL 网关或临时 IP。 */
export async function normalizeLocalObjectUrls(db: AppDatabase, siteUrl: string): Promise<number> {
  const tables = [
    { table: 'media', columns: ['url', 'thumb_url'] },
    { table: 'music', columns: ['url', 'cover'] },
    { table: 'posts', columns: ['cover', 'og_image'] }
  ];
  let changedRows = 0;

  for (const { table, columns } of tables) {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await db.all<Record<string, unknown>>(`SELECT id, ${columns.join(',')} FROM ${table}`);
    } catch {
      continue;
    }

    for (const row of rows) {
      const updates: Array<[string, string]> = [];
      for (const column of columns) {
        const value = row[column];
        if (typeof value !== 'string' || !value || value.startsWith('/')) continue;
        let parsed: URL;
        try {
          parsed = new URL(value);
        } catch {
          continue;
        }
        if (!LOCAL_OBJECT_PATH.test(parsed.pathname)) continue;
        if (!isLocalOrSiteHost(parsed.hostname, siteUrl)) continue;
        updates.push([column, parsed.pathname + parsed.search + parsed.hash]);
      }
      if (!updates.length) continue;
      const assignments = updates.map(([column]) => `${column} = ?`).join(', ');
      await db.prepare(`UPDATE ${table} SET ${assignments} WHERE id = ?`).bind(
        ...updates.map(([, value]) => value),
        String(row.id)
      ).run();
      changedRows += 1;
    }
  }

  return changedRows;
}
export function createLocalStorage(options: LocalStorageOptions): LocalStorage {
  return new LocalStorage(options);
}