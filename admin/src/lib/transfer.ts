/* ============================================================
 * 文章导入导出（移植自原版 app/public/admin.js 的 transfer* 系列）
 * ------------------------------------------------------------
 * 与原版保持同一套交换格式，方便两版之间互相搬运：
 *   · Markdown：YAML 风格 front matter + 正文
 *   · JSON    ：{ format: 'qingyu-blog-posts', version: 1, posts: [...] }
 *   · ZIP     ：每篇文章一个 .md + 一份 posts.json（store 不压缩）
 * 维持零依赖：ZIP 由本文件内的最小实现生成，不引入 jszip。
 * ============================================================ */
import type { PostDetail } from './api';

/** 导入 / 导出共用的文章形态：除 id、title 外的字段都可以缺省。 */
export type TransferPost = Partial<PostDetail> & { id: string; title: string };

/** 原版数据里 OG 图可能叫 og_image，两种写法都要认。 */
type LoosePost = TransferPost & { og_image?: string };

/** 导入时读到的原始条目，字段类型未定，交给 normalizePost 收敛。 */
type ImportInput = Record<string, unknown>;

/* ------------------------------------------------------------
 * 下载
 * ------------------------------------------------------------ */

function saveBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(name: string, text: string, type = 'text/plain;charset=utf-8'): void {
  saveBlob(name, new Blob([String(text ?? '')], { type }));
}

export function downloadBlob(name: string, blob: Blob): void {
  saveBlob(name, blob);
}

/** 用于文件名的时间戳，如 20261007-1530。 */
export function stamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}`
  );
}

/* ------------------------------------------------------------
 * 通用转换
 * ------------------------------------------------------------ */

export function toSlug(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function toTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return toTags(parsed);
    } catch {
      /* 不是 JSON 数组，按分隔符切 */
    }
  }
  return raw
    .split(/[,，、]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function scalar(raw: unknown): unknown {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  const first = value.charAt(0);
  if (first === '"' || first === '[' || first === '{') {
    try {
      return JSON.parse(value);
    } catch {
      /* 不是合法 JSON，当普通字符串 */
    }
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/** 统一收敛成可直接提交给后端的文章对象；非法条目返回 null。 */
function normalizePost(post: ImportInput | null, fallbackId: string): TransferPost | null {
  if (!post || typeof post !== 'object') return null;
  const title = String(post.title ?? '').trim();
  const id = toSlug(post.id || title || fallbackId || `post-${Date.now().toString(36)}`);
  if (!id) return null;

  let enc: unknown = post.enc;
  if (typeof enc === 'string' && enc) {
    try {
      enc = JSON.parse(enc);
    } catch {
      enc = null;
    }
  }
  const isProtected = Boolean(post.protected && enc);

  const rawStatus = String(post.status ?? '');
  const status: PostDetail['status'] =
    rawStatus === 'draft' ? 'draft' : rawStatus === 'scheduled' ? 'scheduled' : 'published';

  const publishAtRaw = post.publishAt ?? post.publish_at;
  let publishAt = Number(publishAtRaw) || (publishAtRaw ? Date.parse(String(publishAtRaw)) : NaN);
  if (!Number.isFinite(publishAt) || publishAt <= 0) publishAt = NaN as unknown as number;

  return {
    id,
    title: title || String(fallbackId || id).trim() || '无标题',
    date: String(post.date ?? new Date().toISOString().slice(0, 10)),
    tags: toTags(post.tags),
    excerpt: String(post.excerpt ?? ''),
    cover: String(post.cover ?? ''),
    ogImage: String(post.ogImage ?? post.og_image ?? ''),
    category: String(post.category ?? ''),
    series: String(post.series ?? ''),
    seriesOrder: Math.max(0, Math.floor(Number(post.seriesOrder ?? post.series_order) || 0)),
    status,
    publishAt: status === 'scheduled' && Number.isFinite(publishAt) ? publishAt : null,
    pinned: Boolean(Number(post.pinned) || post.pinned === true),
    protected: isProtected,
    enc: isProtected ? enc : null,
    content: String(post.content ?? '')
  };
}

/* ------------------------------------------------------------
 * Markdown ⇄ 文章
 * ------------------------------------------------------------ */

export function postToMarkdown(post: TransferPost): string {
  const src = post as LoosePost;
  const lines = ['---'];
  const stringKeys: Array<[string, unknown]> = [
    ['id', src.id],
    ['title', src.title],
    ['date', src.date],
    ['excerpt', src.excerpt],
    ['cover', src.cover],
    ['og_image', src.ogImage ?? src.og_image],
    ['category', src.category],
    ['series', src.series]
  ];
  stringKeys.forEach(([key, value]) => {
    const text = String(value ?? '');
    if (text !== '') lines.push(`${key}: ${JSON.stringify(text)}`);
  });
  lines.push(`tags: ${JSON.stringify(src.tags ?? [])}`);
  lines.push(`series_order: ${JSON.stringify(Number(src.seriesOrder) || 0)}`);
  lines.push(`pinned: ${src.pinned ? 'true' : 'false'}`);
  lines.push(
    `status: ${JSON.stringify(
      src.status === 'draft' ? 'draft' : src.status === 'scheduled' ? 'scheduled' : 'published'
    )}`
  );
  if (src.publishAt) {
    lines.push(`publish_at: ${JSON.stringify(new Date(Number(src.publishAt)).toISOString())}`);
  }
  if (src.protected) lines.push('protected: true');
  if (src.enc) lines.push(`enc: ${JSON.stringify(src.enc)}`);
  lines.push('---', '');
  return `${lines.join('\n')}${String(src.content ?? '').replace(/\s*$/, '')}\n`;
}

export function parseMarkdown(text: string, filename: string): TransferPost | null {
  const src = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  const meta: ImportInput = {};
  let body = src;

  if (src.slice(0, 3) === '---') {
    const end = src.indexOf('\n---', 3);
    if (end >= 0) {
      const block = src.slice(4, end);
      body = src.slice(end + 4).replace(/^\n/, '');
      block.split('\n').forEach((line) => {
        const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
        if (match) meta[match[1].toLowerCase()] = scalar(match[2]);
      });
    }
  }

  const base = String(filename ?? '')
    .replace(/^.*[\\/]/, '')
    .replace(/\.(md|markdown)$/i, '');
  const title = String(meta.title ?? base).trim();
  const id = toSlug(meta.id || title || base || `post-${Date.now().toString(36)}`);

  return normalizePost(
    {
      ...meta,
      id,
      title: title || base || '无标题',
      content: body.replace(/^\n+|\n+$/g, '')
    },
    base
  );
}

export function parseJson(text: string): TransferPost[] {
  const data: unknown = JSON.parse(String(text ?? ''));
  let raw: unknown[] = [];

  if (Array.isArray(data)) {
    raw = data;
  } else if (data && typeof data === 'object') {
    const box = data as Record<string, unknown>;
    if (Array.isArray(box.posts)) raw = box.posts;
    else if (box.post && typeof box.post === 'object') raw = [box.post];
    else raw = [data];
  }

  return raw
    .map((item) => normalizePost(item as ImportInput, ''))
    .filter((item): item is TransferPost => item !== null);
}

export function backupJson(posts: TransferPost[]): string {
  return JSON.stringify(
    {
      format: 'qingyu-blog-posts',
      version: 1,
      exportedAt: new Date().toISOString(),
      posts
    },
    null,
    2
  );
}

export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取失败'));
    reader.readAsText(file);
  });
}

/* ------------------------------------------------------------
 * 最小 ZIP 实现（store 方式，不压缩）
 * ------------------------------------------------------------ */

let crcTable: number[] | null = null;

function crc32(data: Uint8Array<ArrayBuffer>): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n: number): number[] => [
  n & 0xff,
  (n >>> 8) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 24) & 0xff
];

function concat(parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  let length = 0;
  parts.forEach((part) => {
    length += part.length;
  });
  const out = new Uint8Array(length);
  let offset = 0;
  parts.forEach((part) => {
    out.set(part, offset);
    offset += part.length;
  });
  return out;
}

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

export interface ZipEntry {
  name: string;
  text?: string;
  data?: Uint8Array<ArrayBuffer>;
}

export function zipFiles(files: ZipEntry[]): Blob {
  const local: Uint8Array<ArrayBuffer>[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  const dt = dosTime(new Date());
  const encoder = new TextEncoder();

  files.forEach((file) => {
    const name = encoder.encode(file.name);
    const data = file.data ?? encoder.encode(String(file.text ?? ''));
    const crc = crc32(data);

    const localHead = concat([
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      new Uint8Array(u16(20)),
      new Uint8Array(u16(0x0800)),
      new Uint8Array(u16(0)),
      new Uint8Array(u16(dt.time)),
      new Uint8Array(u16(dt.date)),
      new Uint8Array(u32(crc)),
      new Uint8Array(u32(data.length)),
      new Uint8Array(u32(data.length)),
      new Uint8Array(u16(name.length)),
      new Uint8Array(u16(0)),
      name,
      data
    ]);
    local.push(localHead);

    central.push(
      concat([
        new Uint8Array([0x50, 0x4b, 0x01, 0x02]),
        new Uint8Array(u16(20)),
        new Uint8Array(u16(20)),
        new Uint8Array(u16(0x0800)),
        new Uint8Array(u16(0)),
        new Uint8Array(u16(dt.time)),
        new Uint8Array(u16(dt.date)),
        new Uint8Array(u32(crc)),
        new Uint8Array(u32(data.length)),
        new Uint8Array(u32(data.length)),
        new Uint8Array(u16(name.length)),
        new Uint8Array(u16(0)),
        new Uint8Array(u16(0)),
        new Uint8Array(u16(0)),
        new Uint8Array(u16(0)),
        new Uint8Array(u32(0)),
        new Uint8Array(u32(offset)),
        name
      ])
    );
    offset += localHead.length;
  });

  const centralData = concat(central);
  const end = concat([
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
    new Uint8Array(u16(0)),
    new Uint8Array(u16(0)),
    new Uint8Array(u16(files.length)),
    new Uint8Array(u16(files.length)),
    new Uint8Array(u32(centralData.length)),
    new Uint8Array(u32(offset)),
    new Uint8Array(u16(0))
  ]);

  return new Blob([...local, centralData, end], { type: 'application/zip' });
}

/** 把一批文章打成 ZIP：每篇一个 .md，外加一份 posts.json。 */
export function zipForPosts(posts: TransferPost[]): Blob {
  const used: Record<string, boolean> = {};
  const files: ZipEntry[] = [];

  posts.forEach((post) => {
    const base = toSlug(post.title || post.id || 'post') || 'post';
    let name = `${base}.md`;
    let n = 2;
    while (used[name]) {
      name = `${base}-${n}.md`;
      n += 1;
    }
    used[name] = true;
    files.push({ name, text: postToMarkdown(post) });
  });

  files.push({ name: 'posts.json', text: backupJson(posts) });
  return zipFiles(files);
}