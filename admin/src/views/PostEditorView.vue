<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  Save, Loader2, ArrowLeft, Eye, Pencil, Columns2, ImagePlus, ExternalLink, Trash2, CalendarClock,
  History, Link2, Sparkles, Copy, X, Undo2, Check, Wand,
  Bold, Italic, Strikethrough, Heading, Quote, Code, List, ListOrdered, ListChecks, Link,
  Image, Minus, Table, Smile, Lock, Unlock, Images
} from '@lucide/vue';
import {
  api, uploadTo, ApiError,
  type Seo, type PostDetail, type PostRevisionMeta, type PostRevisionDetail, type MediaItem
} from '../lib/api';
import { debounce, slugify, formatDateTime } from '../lib/format';
import { toast } from '../lib/toast';

const route = useRoute();
const router = useRouter();

const isNew = computed(() => route.name === 'post-new');
const id = computed(() => String(route.params.id ?? ''));

const loading = ref(!isNew.value);
const saving = ref(false);
const uploading = ref(false);
const pasting = ref(false);
const mode = ref<'write' | 'split' | 'preview'>('split');
const fileInput = ref<HTMLInputElement | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);

const form = ref({
  id: '',
  title: '',
  excerpt: '',
  content: '',
  cover: '',
  ogImage: '',
  date: '',
  tags: '',
  category: '',
  series: '',
  seriesOrder: 0,
  author: '',
  status: 'draft' as 'published' | 'draft' | 'scheduled',
  publishAt: '' as string,
  pinned: false,
  protected: false,
  seo: { title: '', desc: '', canonical: '', noindex: false } as Seo
});

/* ---------- 日期工具（与上游 admin.js:58-87 同口径：本地时间、datetime-local） ---------- */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function localDateTimeValue(d: Date): string {
  return (
    d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  );
}
/** 把服务端的日期字符串 / 毫秒时间戳转成 <input type=datetime-local> 需要的本地格式 */
function toDateTimeLocal(v: string | number | null | undefined): string {
  const s = String(v ?? '').trim();
  if (/^\d{12,}$/.test(s)) {
    const d = new Date(Number(s));
    if (!Number.isNaN(d.getTime())) return localDateTimeValue(d);
  }
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (m) return m[1] + 'T' + (m[2] ? (m[2].length === 1 ? '0' + m[2] : m[2]) + ':' + m[3] : '00:00');
  return s;
}

/* ---------- 预览：marked 渲染 + DOMPurify 消毒 ---------- */
const rendered = ref('');
const renderPreview = debounce((markdown: string) => {
  const html = marked.parse(markdown || '', { async: false }) as string;
  rendered.value = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}, 180);

watch(() => form.value.content, (value) => renderPreview(value), { immediate: true });

/* ---------- 正文统计：中日韩按字、拉丁按词，400 字/分钟（上游 admin.js:2947-2954） ---------- */
const editorStats = computed(() => {
  const str = form.value.content || '';
  const cjk = (str.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const words = (str.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
  const total = cjk + words;
  return {
    lines: str ? str.split('\n').length : 0,
    chars: str.length,
    words: total,
    minutes: Math.max(1, Math.ceil(total / 400))
  };
});

/* ---------- 编辑区自动增高（上游 admin.js:2941-2945） ---------- */
function autosize(): void {
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.max(el.scrollHeight, 480) + 'px';
}
watch([() => form.value.content, mode], () => {
  void nextTick(autosize);
});

/* ============================================================
 * Markdown 工具栏（上游 admin.js:2771-2787 / 2963-2988）
 * 直接作用于 textarea 选区；优先用 execCommand('insertText')
 * 以保留浏览器撤销历史，失败时退回直接改 value + 派发 input。
 * ============================================================ */
const mdLang = ref('');
const emojiOpen = ref(false);
const EMOJIS = [
  '😀', '😄', '😁', '😆', '😅', '😂', '🙂', '😉', '😊', '😍', '😘', '😎',
  '🤔', '😐', '😴', '😭', '😡', '👍', '👎', '👏', '🙏', '💪', '🎉', '🔥',
  '✨', '⭐', '❤️', '💔', '✅', '❌', '⚠️', '📌', '📖', '🚀', '💡', '☕',
  '🌱', '🌸', '🍃', '🐛', '🛠️', '📝', '🔗', '⌛', '🎯', '🏷️', '🔍', '🤝'
];

const mdLangOptions = [
  { value: '', label: '纯文本' },
  { value: 'js', label: 'JavaScript' },
  { value: 'ts', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'bash', label: 'Bash' },
  { value: 'json', label: 'JSON' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'sql', label: 'SQL' },
  { value: 'go', label: 'Go' },
  { value: 'java', label: 'Java' }
];

/** 在 textarea 的 [start,end] 区间写入 text，并把光标放到 caret（保留撤销） */
function insertText(el: HTMLTextAreaElement, start: number, end: number, text: string, caret: number): void {
  el.focus();
  el.setSelectionRange(start, end);
  let ok = false;
  try {
    ok = document.execCommand('insertText', false, text);
  } catch {
    ok = false;
  }
  if (!ok) {
    const v = el.value;
    el.value = v.slice(0, start) + text + v.slice(end);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.setSelectionRange(caret, caret);
}

function insertMd(type: string): void {
  const el = textareaRef.value;
  if (!el) return;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  const value = el.value;
  const sel = value.slice(start, end);
  let pre = '';
  let post = '';
  let rep = sel;
  switch (type) {
    case 'bold': pre = '**'; post = '**'; break;
    case 'italic': pre = '*'; post = '*'; break;
    case 'strike': pre = '~~'; post = '~~'; break;
    case 'h': pre = '## '; break;
    case 'quote': pre = '> '; break;
    case 'code': pre = '`'; post = '`'; break;
    case 'ul': pre = '- '; break;
    case 'ol': pre = '1. '; break;
    case 'task': pre = '- [ ] '; break;
    case 'hr': rep = (start > 0 && value.charAt(start - 1) !== '\n' ? '\n' : '') + '---\n'; break;
    case 'table':
      rep = '| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n';
      break;
    case 'codeblock': {
      const lang = mdLang.value.trim();
      rep = '```' + lang + '\n' + (sel || '') + '\n```';
      break;
    }
    case 'link': rep = '[' + (sel || '链接') + '](https://)'; break;
    case 'img': rep = '![' + (sel || '图片') + '](https://)'; break;
    case 'wiki': rep = '[[' + (sel || '双链') + ']]'; break;
    default: return;
  }
  const inserted = pre + rep + post;
  insertText(el, start, end, inserted, start + pre.length + rep.length);
}

function insertEmoji(emoji: string): void {
  const el = textareaRef.value;
  emojiOpen.value = false;
  if (!el) return;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  insertText(el, start, end, emoji, start + emoji.length);
}

/** 快捷键：Ctrl/⌘ + B / I / K（上游 admin.js:2833-2846） */
function onContentKeydown(e: KeyboardEvent): void {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = String(e.key || '').toLowerCase();
  if (k === 'b') {
    e.preventDefault();
    insertMd('bold');
  } else if (k === 'i') {
    e.preventDefault();
    insertMd('italic');
  } else if (k === 'k') {
    e.preventDefault();
    insertMd('link');
  }
}

/* ---------- 粘贴图片上传（上游 admin.js:2824-2832 / 2914-2929） ---------- */
async function onContentPaste(e: ClipboardEvent): Promise<void> {
  const items = e.clipboardData?.items;
  if (!items) return;
  let file: File | null = null;
  for (const it of Array.from(items)) {
    if (it.type && it.type.startsWith('image/')) {
      file = it.getAsFile();
      break;
    }
  }
  if (!file) return;
  e.preventDefault();
  await uploadPastedImage(file);
}

async function uploadPastedImage(file: File): Promise<void> {
  const el = textareaRef.value;
  if (!el) return;
  pasting.value = true;
  toast.info('正在上传粘贴的图片…');
  try {
    const name = file.name || `pasted-${Date.now()}.png`;
    const ticket = await api.uploadTicket(name, file.size, false);
    await uploadTo(ticket.uploadUrl, file, ticket.contentType || file.type || 'image/png');
    await api
      .registerMedia({ name, url: ticket.publicUrl, type: ticket.contentType || file.type, size: file.size })
      .catch(() => undefined);
    const md = `![粘贴的图片](${ticket.publicUrl})`;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    insertText(el, start, end, md, start + md.length);
    toast.success('图片已上传并插入正文');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '图片上传失败');
  } finally {
    pasting.value = false;
  }
}

/* ---------- 载入 ---------- */
const protectedEnc = ref<unknown>(null);
const hasEnc = ref(false);
const unlocked = ref(false);
const unlocking = ref(false);

function fillForm(post: PostDetail): void {
  form.value = {
    id: post.id,
    title: post.title,
    excerpt: post.excerpt,
    content: post.content,
    cover: post.cover || post.ogImage || '',
    ogImage: post.ogImage || '',
    date: toDateTimeLocal(post.date || ''),
    tags: (post.tags ?? []).join(', '),
    category: post.category ?? '',
    series: post.series ?? '',
    seriesOrder: Number(post.seriesOrder) || 0,
    author: post.author ?? '',
    status: (post.status ?? 'draft') as typeof form.value.status,
    publishAt: post.publishAt ? toDateTimeLocal(post.publishAt) : '',
    pinned: post.pinned,
    protected: !!post.protected,
    seo: { title: '', desc: '', canonical: '', noindex: false, ...(post.seo ?? {}) }
  };
  ogSource.value = ogFingerprint();
  protectedEnc.value = post.enc ?? null;
  hasEnc.value = !!(post.protected && post.enc);
  unlocked.value = false;
  protectPwd.value = post.protected ? readPostPwd(post.id) : '';
}

/* ---------- 分类 / 作者补全数据（上游 admin.js:2990-3022） ---------- */
const navCategories = ref<string[]>([]);
const postCategories = ref<string[]>([]);
const postAuthors = ref<string[]>([]);
const profileName = ref('');

function uniq(list: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const name = (raw ?? '').trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

const categoryOptions = computed(() => uniq([...navCategories.value, ...postCategories.value]));
const authorOptions = computed(() => uniq([profileName.value, ...postAuthors.value]));

async function loadCompletionLists(): Promise<void> {
  try {
    const { posts } = await api.listPosts({ all: true });
    postCategories.value = uniq(posts.map((p) => p.category));
    postAuthors.value = uniq(posts.map((p) => p.author));
  } catch {
    /* 拉取失败不阻塞编辑 */
  }
}

/* ---------- 本地草稿自动保存 / 恢复（上游 admin.js:2663-2733） ---------- */
const DRAFT_PREFIX = 'qingyu.editorDraft.';
const draftSavedAt = ref(0);
let draftTimer: number | undefined;

interface DraftData {
  id: string;
  title: string;
  excerpt: string;
  tags: string;
  category: string;
  series: string;
  seriesOrder: number;
  author: string;
  cover: string;
  date: string;
  status: 'published' | 'draft' | 'scheduled';
  publishAt: string;
  pinned: boolean;
  seoTitle: string;
  seoDesc: string;
  seoCanonical: string;
  seoNoindex: boolean;
  body: string;
}

const draftFound = ref<{ savedAt: number; data: DraftData } | null>(null);

function draftKey(): string {
  return isNew.value ? '__new' : id.value;
}

function readDraft(): { savedAt: number; data: DraftData } | null {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + draftKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt?: number; data?: DraftData };
    if (!parsed || !parsed.data) return null;
    return { savedAt: Number(parsed.savedAt) || 0, data: parsed.data };
  } catch {
    return null;
  }
}

function writeDraft(data: DraftData): void {
  try {
    localStorage.setItem(DRAFT_PREFIX + draftKey(), JSON.stringify({ v: 1, savedAt: Date.now(), data }));
  } catch {
    /* 隐私模式 / 配额不足时忽略 */
  }
}

function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_PREFIX + draftKey());
  } catch {
    /* ignore */
  }
}

function collectDraft(): DraftData {
  return {
    id: form.value.id,
    title: form.value.title,
    excerpt: form.value.excerpt,
    tags: form.value.tags,
    category: form.value.category,
    series: form.value.series,
    seriesOrder: form.value.seriesOrder,
    author: form.value.author,
    cover: form.value.cover,
    date: form.value.date,
    status: form.value.status,
    publishAt: form.value.publishAt,
    pinned: form.value.pinned,
    seoTitle: form.value.seo.title ?? '',
    seoDesc: form.value.seo.desc ?? '',
    seoCanonical: form.value.seo.canonical ?? '',
    seoNoindex: !!form.value.seo.noindex,
    body: form.value.content
  };
}

function autosaveDraft(): void {
  // 加密文章不把待加密正文写进浏览器存储（上游 admin.js:2674-2677）
  if (form.value.protected) {
    clearDraft();
    draftSavedAt.value = 0;
    return;
  }
  const d = collectDraft();
  if (!d.title && !d.body) return; // 空编辑器不产生草稿
  writeDraft(d);
  draftSavedAt.value = Date.now();
}

const scheduleDraft = debounce(autosaveDraft, 1500);

function restoreDraft(): void {
  const found = draftFound.value;
  if (!found) return;
  const d = found.data;
  form.value = {
    ...form.value,
    id: d.id,
    title: d.title,
    excerpt: d.excerpt,
    tags: d.tags,
    category: d.category,
    series: d.series,
    seriesOrder: d.seriesOrder,
    author: d.author,
    cover: d.cover,
    date: d.date,
    status: d.status,
    publishAt: d.publishAt,
    pinned: d.pinned,
    seo: { title: d.seoTitle, desc: d.seoDesc, canonical: d.seoCanonical, noindex: d.seoNoindex }
  };
  form.value.content = d.body;
  draftFound.value = null;
  void nextTick(autosize);
  toast.success('已恢复本地草稿');
}

function discardDraft(): void {
  clearDraft();
  draftFound.value = null;
  draftSavedAt.value = 0;
  toast.success('已丢弃本地草稿');
}

/* ---------- 分享图（OG）：Canvas 1200×630 + 签名直传 ---------- */
const ogAuto = ref(true);
const ogGenerating = ref(false);
/** 上次成功生成分享图时的标题/日期/标签/系列指纹，变了才需要重画 */
const ogSource = ref('');
const siteName = ref("Qingyu'Blog");

function parseTags(raw: string): string[] {
  return raw.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
}

function ogFingerprint(): string {
  return [
    form.value.title.trim(),
    form.value.date.slice(0, 10),
    parseTags(form.value.tags).join(','),
    form.value.series.trim()
  ].join('|');
}

/** 长标题按字符折行，最多 maxLines 行，超出用省略号收尾 */
function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const lines: string[] = [];
  let line = '';
  for (const ch of Array.from(text)) {
    const test = line + ch;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines) {
        let last = lines[lines.length - 1];
        while (last.length > 1 && ctx.measureText(last + '…').width > maxWidth) {
          last = last.slice(0, -1);
        }
        lines[lines.length - 1] = last + '…';
        return lines;
      }
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

/** 画图 → 编码 PNG → 取签名 → 直传，返回可写进文章的 publicUrl */
async function generateShareImage(): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 630;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持 Canvas');

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#b15635';
  const grad = ctx.createLinearGradient(0, 0, 1200, 630);
  grad.addColorStop(0, '#f8f2e9');
  grad.addColorStop(0.55, '#ffffff');
  grad.addColorStop(1, '#efe3d4');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1200, 630);

  ctx.globalAlpha = 0.12;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(1050, 80, 260, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(80, 590, 230, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.fillStyle = accent;
  ctx.fillRect(92, 86, 8, 108);

  ctx.fillStyle = '#332b25';
  ctx.font = '700 72px "Microsoft YaHei","PingFang SC",sans-serif';
  const lines = wrapCanvasText(ctx, form.value.title.trim() || '无标题', 960, 3);
  lines.forEach((text, i) => ctx.fillText(text, 130, 150 + i * 86));

  ctx.font = '28px "Microsoft YaHei","PingFang SC",sans-serif';
  ctx.fillStyle = '#766b61';
  const meta = [
    form.value.date.slice(0, 10),
    form.value.series.trim(),
    parseTags(form.value.tags).slice(0, 3).join(' · ')
  ].filter(Boolean).join('  ·  ');
  ctx.fillText(meta, 132, 500);

  ctx.font = '600 28px "Microsoft YaHei","PingFang SC",sans-serif';
  ctx.fillStyle = accent;
  ctx.fillText(siteName.value, 132, 555);

  ctx.fillStyle = '#c9b9a8';
  ctx.fillRect(132, 580, 936, 2);
  ctx.font = '20px "Microsoft YaHei","PingFang SC",sans-serif';
  ctx.fillStyle = '#9a8d80';
  ctx.fillText('1200 × 630  ·  Open Graph', 760, 602);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('图片编码失败');

  const postId = form.value.id.trim() || slugify(form.value.title) || 'post';
  const signed = await api.ogUploadUrl(postId);
  await uploadTo(signed.uploadUrl, blob, 'image/png');
  return signed.publicUrl;
}

/** 手动按钮：画图并写入表单（不保存文章） */
async function generateOg(): Promise<void> {
  if (!form.value.title.trim()) {
    toast.error('请先填写标题');
    return;
  }
  ogGenerating.value = true;
  try {
    const url = await generateShareImage();
    form.value.ogImage = url;
    ogSource.value = ogFingerprint();
    toast.success('分享图已生成');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '分享图生成失败');
  } finally {
    ogGenerating.value = false;
  }
}

/* ============================================================
 * 文章加密（AES-GCM 256 + PBKDF2-SHA256 100000 轮）
 * 算法与格式完全照搬前台 app.js:869-891 的 pfEncrypt/pfDecrypt，
 * 确保与本仓库前台解密逻辑兼容（同一密文结构可互相解开）。
 * ============================================================ */
const PF_ITER = 100000;
const POST_PWD_PREFIX = 'qingyu.postPwd.';

function u8ToB64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
function b64ToU8(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
async function pfDeriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveKey'
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
async function pfEncrypt(text: string, password: string): Promise<Record<string, unknown>> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await pfDeriveKey(password, salt, PF_ITER);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return {
    v: 1,
    alg: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iter: PF_ITER,
    salt: u8ToB64(salt),
    iv: u8ToB64(iv),
    data: u8ToB64(new Uint8Array(ct))
  };
}
async function pfDecrypt(encObj: unknown, password: string): Promise<string> {
  const e = encObj as { data?: string; salt?: string; iv?: string; iter?: number };
  if (!e || !e.data || !e.salt || !e.iv) throw new Error('bad-format');
  const key = await pfDeriveKey(password, b64ToU8(e.salt), Number(e.iter) || PF_ITER);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToU8(e.iv) }, key, b64ToU8(e.data));
  return new TextDecoder().decode(pt);
}

function rememberPostPwd(postId: string, pwd: string): void {
  try {
    if (postId && pwd) localStorage.setItem(POST_PWD_PREFIX + postId, pwd);
  } catch {
    /* ignore */
  }
}
function readPostPwd(postId: string): string {
  try {
    return localStorage.getItem(POST_PWD_PREFIX + postId) || '';
  } catch {
    return '';
  }
}
function forgetPostPwd(postId: string): void {
  try {
    if (postId) localStorage.removeItem(POST_PWD_PREFIX + postId);
  } catch {
    /* ignore */
  }
}

const protectPwd = ref('');
const pwdVisible = ref(false);

async function unlockEncrypted(): Promise<void> {
  if (!protectedEnc.value) return;
  if (!protectPwd.value) {
    toast.error('请输入文章密码');
    return;
  }
  unlocking.value = true;
  try {
    const plain = await pfDecrypt(protectedEnc.value, protectPwd.value);
    form.value.content = plain;
    unlocked.value = true;
    void nextTick(autosize);
    rememberPostPwd(form.value.id.trim() || id.value, protectPwd.value);
    toast.success('正文已解锁');
  } catch {
    toast.error('密码错误或密文损坏');
  } finally {
    unlocking.value = false;
  }
}

/* ---------- 保存 ---------- */
function buildPayload(contentValue: string, encValue: unknown): Partial<PostDetail> {
  const normalizedDate = form.value.date
    ? form.value.date.replace('T', ' ')
    : localDateTimeValue(new Date()).replace('T', ' ');
  const payload: Partial<PostDetail> = {
    title: form.value.title.trim(),
    excerpt: form.value.excerpt.trim(),
    content: contentValue,
    cover: form.value.cover.trim(),
    ogImage: form.value.ogImage.trim(),
    tags: form.value.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
    category: form.value.category.trim(),
    series: form.value.series.trim(),
    seriesOrder: Math.max(0, Math.floor(Number(form.value.seriesOrder) || 0)),
    author: form.value.author.trim(),
    status: form.value.status,
    pinned: form.value.pinned,
    protected: form.value.protected,
    enc: encValue,
    seo: form.value.seo,
    date: normalizedDate
  };
  if (form.value.status === 'scheduled' && form.value.publishAt) {
    payload.publishAt = new Date(form.value.publishAt).getTime();
  }
  return payload;
}

async function save(nextStatus?: typeof form.value.status): Promise<void> {
  if (nextStatus) form.value.status = nextStatus;
  if (!form.value.title.trim()) {
    toast.error('请填写标题');
    return;
  }
  if (isNew.value && !form.value.id.trim()) {
    toast.error('请填写文章 ID（URL 别名）');
    return;
  }
  if (form.value.status === 'scheduled') {
    const at = form.value.publishAt ? new Date(form.value.publishAt).getTime() : 0;
    if (!at || at <= Date.now()) {
      toast.error('请选择未来的发布时间');
      return;
    }
  }

  // 文章加密：勾选后把正文加密存入 enc，明文 content 置空（上游 admin.js:3080-3096）
  let encData: unknown = null;
  let contentToSave = form.value.content;
  const postId = form.value.id.trim() || id.value;
  if (form.value.protected) {
    if (!protectPwd.value) {
      toast.error('请填写文章密码');
      return;
    }
    if (hasEnc.value && !unlocked.value && !form.value.content.trim()) {
      toast.error('请先用密码解锁正文再保存');
      return;
    }
    try {
      encData = await pfEncrypt(form.value.content, protectPwd.value);
    } catch {
      toast.error('加密失败，请重试');
      return;
    }
    contentToSave = '';
    rememberPostPwd(postId, protectPwd.value);
  } else {
    forgetPostPwd(postId);
  }

  saving.value = true;
  try {
    if (isNew.value && !form.value.date) form.value.date = localDateTimeValue(new Date());
    const fingerprint = ogFingerprint();
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    if (ogAuto.value && online && !form.value.protected && (!form.value.ogImage || ogSource.value !== fingerprint)) {
      ogGenerating.value = true;
      try {
        form.value.ogImage = await generateShareImage();
        ogSource.value = fingerprint;
      } catch {
        /* 分享图生成失败不阻塞文章保存 */
      } finally {
        ogGenerating.value = false;
      }
    }
    const payload = buildPayload(contentToSave, encData);
    if (isNew.value) {
      await api.createPost({ ...payload, id: form.value.id.trim(), title: form.value.title.trim() });
      toast.success('已创建');
      clearDraft();
      draftFound.value = null;
      await router.replace({ name: 'post-edit', params: { id: form.value.id.trim() } });
    } else {
      await api.updatePost(id.value, payload);
      toast.success('已保存');
      clearDraft();
      draftFound.value = null;
      draftSavedAt.value = 0;
    }
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

/* ---------- 封面：走媒体库的直传流程 ---------- */
async function uploadCover(file: File): Promise<void> {
  uploading.value = true;
  try {
    const ticket = await api.uploadTicket(file.name, file.size, false);
    await uploadTo(ticket.uploadUrl, file, ticket.contentType || file.type);
    form.value.cover = ticket.publicUrl;
    await api
      .registerMedia({
        name: file.name,
        url: ticket.publicUrl,
        type: ticket.contentType || file.type,
        size: file.size
      })
      .catch(() => undefined);
    toast.success('封面上传成功');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '上传失败');
  } finally {
    uploading.value = false;
    if (fileInput.value) fileInput.value.value = '';
  }
}

/* ---------- 媒体库选择器（封面 / OG 图，上游 admin.js:3160-3176） ---------- */
const mediaOpen = ref(false);
const mediaLoading = ref(false);
const mediaList = ref<MediaItem[]>([]);
const mediaTarget = ref<'cover' | 'ogImage'>('cover');

async function openMediaPicker(target: 'cover' | 'ogImage'): Promise<void> {
  mediaTarget.value = target;
  mediaOpen.value = true;
  mediaLoading.value = true;
  mediaList.value = [];
  try {
    const { media } = await api.listMedia();
    mediaList.value = media;
  } catch (e) {
    mediaOpen.value = false;
    toast.error(e instanceof ApiError ? e.message : '加载媒体库失败');
  } finally {
    mediaLoading.value = false;
  }
}

function pickMedia(item: MediaItem): void {
  form.value[mediaTarget.value] = item.url;
  if (mediaTarget.value === 'ogImage') ogSource.value = ogFingerprint();
  mediaOpen.value = false;
  toast.success('已选择');
}

/** 「设为现在」：一键把日期填成当前本地时间（上游 admin.js:2854-2856） */
function setNow(): void {
  form.value.date = localDateTimeValue(new Date());
}

async function remove(): Promise<void> {
  if (!window.confirm('确定删除这篇文章？')) return;
  try {
    await api.deletePost(id.value);
    clearDraft();
    toast.success('已删除');
    void router.replace({ name: 'posts' });
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '删除失败');
  }
}

/* ---------- AI 写作助手（服务端未配置时整块隐藏） ---------- */
const aiAvailable = ref(false);
const aiLang = ref('zh-CN');
const aiBusy = ref(false);
const aiAction = ref<'' | 'title' | 'tags' | 'polish' | 'translate'>('');
const aiResult = ref('');
const aiError = ref('');

const aiActions = [
  { key: 'title', label: '标题建议' },
  { key: 'tags', label: '标签建议' },
  { key: 'polish', label: '润色' },
  { key: 'translate', label: '翻译' }
] as const;

type AiActionKey = (typeof aiActions)[number]['key'];

async function aiRun(action: AiActionKey): Promise<void> {
  if (aiBusy.value) return;
  const isBody = action === 'polish' || action === 'translate';
  const source = isBody
    ? form.value.content
    : action === 'title'
      ? form.value.title
      : form.value.title + '\n' + form.value.tags;
  if (!source.trim()) {
    toast.error(isBody ? '请先写正文' : '请先填写标题');
    return;
  }
  aiBusy.value = true;
  aiAction.value = action;
  aiError.value = '';
  aiResult.value = '';
  try {
    const { result } = await api.aiAssist(action, source, aiLang.value);
    aiResult.value = String(result ?? '').trim();
    if (!aiResult.value) aiError.value = 'AI 没有返回内容，请重试';
  } catch (e) {
    aiError.value = e instanceof ApiError ? e.message : 'AI 请求失败';
  } finally {
    aiBusy.value = false;
  }
}

/** 把 AI 结果写回编辑器：标题 / 标签覆盖对应字段，润色与翻译替换或追加正文。 */
function aiApply(mode: 'replace' | 'append'): void {
  const result = aiResult.value.trim();
  if (!result) return;
  if (aiAction.value === 'title') {
    form.value.title = result.split('\n')[0].replace(/^["“”']+|["“”']+$/g, '').trim();
  } else if (aiAction.value === 'tags') {
    const merged = Array.from(new Set(splitTags(form.value.tags).concat(splitTags(result))));
    form.value.tags = merged.join(', ');
  } else if (mode === 'append') {
    form.value.content = form.value.content.trimEnd() + '\n\n' + result;
  } else {
    form.value.content = result;
  }
  toast.success('已应用到编辑器');
}

function splitTags(text: string): string[] {
  return text
    .split(/[,，、;；\n]/)
    .map((t) => t.replace(/^#/, '').trim())
    .filter(Boolean);
}

/* ---------- 修订历史（查看差异 + 一键回滚） ---------- */
type DiffLine = { type: 'same' | 'add' | 'del'; text: string };

const revOpen = ref(false);
const revisions = ref<PostRevisionMeta[]>([]);
const revSelected = ref<number | null>(null);
const revDetail = ref<PostRevisionDetail | null>(null);
const revLoading = ref(false);
const revRestoring = ref(false);

function revisionReasonLabel(reason: string): string {
  if (reason === 'create') return '创建';
  if (reason === 'restore') return '恢复';
  if (reason === 'update') return '更新';
  return '保存';
}

async function openRevisions(): Promise<void> {
  if (isNew.value) return;
  revOpen.value = true;
  revLoading.value = true;
  revDetail.value = null;
  revSelected.value = null;
  revisions.value = [];
  try {
    const { revisions: list } = await api.listRevisions(id.value);
    revisions.value = list;
    if (list.length) await selectRevision(list[0].id);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '加载修订历史失败');
    revOpen.value = false;
  } finally {
    revLoading.value = false;
  }
}

async function selectRevision(rid: number): Promise<void> {
  revSelected.value = rid;
  revLoading.value = true;
  try {
    const { revision } = await api.getRevision(id.value, rid);
    revDetail.value = revision;
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '加载修订详情失败');
  } finally {
    revLoading.value = false;
  }
}

async function restoreRevision(): Promise<void> {
  const current = revDetail.value;
  if (!current || revRestoring.value) return;
  const ok = window.confirm(
    '确定恢复到 ' + formatDateTime(current.createdAt) + ' 的版本？当前内容会先存为一条修订，随时可以再切回来。'
  );
  if (!ok) return;
  revRestoring.value = true;
  try {
    const { post } = await api.restoreRevision(id.value, current.id);
    fillForm(post);
    toast.success('已恢复该版本，确认无误后记得保存');
    const { revisions: list } = await api.listRevisions(id.value);
    revisions.value = list;
    if (list.length) await selectRevision(list[0].id);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '恢复失败');
  } finally {
    revRestoring.value = false;
  }
}

/* 行级差异（LCS）：旧 = 修订版本，新 = 当前编辑器内容；规模过大时降级为整体替换 */
function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  if (!oldText) return b.map((text) => ({ type: 'add' as const, text }));
  if (!newText) return a.map((text) => ({ type: 'del' as const, text }));
  if (a.length * b.length > 300000) {
    const removed: DiffLine[] = a.map((text) => ({ type: 'del', text }));
    const added: DiffLine[] = b.map((text) => ({ type: 'add', text }));
    return removed.concat(added);
  }
  const cols = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * cols + j] =
        a[i] === b[j] ? dp[(i + 1) * cols + j + 1] + 1 : Math.max(dp[(i + 1) * cols + j], dp[i * cols + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * cols + j] >= dp[i * cols + j + 1]) {
      out.push({ type: 'del', text: a[i] });
      i++;
    } else {
      out.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < a.length) {
    out.push({ type: 'del', text: a[i] });
    i++;
  }
  while (j < b.length) {
    out.push({ type: 'add', text: b[j] });
    j++;
  }
  return out;
}

const diffLines = computed<DiffLine[]>(() =>
  revDetail.value ? lineDiff(revDetail.value.content || '', form.value.content || '') : []
);

/* ---------- 预览链接（签名 token，默认 7 天有效） ---------- */
const pvOpen = ref(false);
const pvLoading = ref(false);
const pvUrl = ref('');
const pvExpires = ref(0);

async function openPreviewLink(): Promise<void> {
  if (isNew.value) return;
  pvOpen.value = true;
  pvUrl.value = '';
  pvExpires.value = 0;
  pvLoading.value = true;
  try {
    const link = await api.previewLink(id.value, 7);
    pvUrl.value = link.url;
    pvExpires.value = link.expiresAt;
  } catch (e) {
    pvOpen.value = false;
    toast.error(e instanceof ApiError ? e.message : '生成预览链接失败');
  } finally {
    pvLoading.value = false;
  }
}

async function copyText(text: string): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast.success('已复制');
  } catch {
    toast.error('复制失败，请手动选中复制');
  }
}

/* ---------- 新建时用标题自动生成 id（用户改过就不再覆盖） ---------- */
const idTouched = ref(false);
watch(
  () => form.value.title,
  (title) => {
    if (!isNew.value || idTouched.value) return;
    form.value.id = slugify(title);
  }
);

/** 全局 Ctrl/⌘ + S：保存为草稿（上游 admin.js:2842-2845） */
function onGlobalKey(e: KeyboardEvent): void {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (String(e.key || '').toLowerCase() === 's') {
    e.preventDefault();
    void save('draft');
  }
}

function onContentInput(): void {
  autosize();
  scheduleDraft();
  emojiOpen.value = false;
}

onMounted(async () => {
  // 站点名 / 个人资料 / 导航分类：供分享图落款与分类补全使用
  void api
    .getSettings()
    .then(({ settings }) => {
      try {
        const parsed = JSON.parse(settings.site || '{}') as { name?: unknown };
        if (parsed && typeof parsed.name === 'string' && parsed.name.trim()) {
          siteName.value = parsed.name.trim();
        }
      } catch {
        /* 设置不是合法 JSON 时忽略 */
      }
      try {
        const prof = JSON.parse(settings.profile || '{}') as { name?: unknown };
        if (prof && typeof prof.name === 'string') profileName.value = prof.name.trim();
      } catch {
        /* ignore */
      }
      try {
        const nav = JSON.parse(settings.nav_menu || '[]') as Array<{
          url?: string;
          children?: Array<{ text?: string }>;
        }>;
        const names: string[] = [];
        for (const item of nav) {
          if (!item || String(item.url || '').replace(/\/+$/, '') !== '/categories') continue;
          for (const child of item.children ?? []) {
            if (child && typeof child.text === 'string') names.push(child.text);
          }
        }
        navCategories.value = uniq(names);
      } catch {
        /* ignore */
      }
    })
    .catch(() => undefined);

  // AI 是否可用：服务端没配置 AI 时接口返回 404，AI 功能整块自动隐藏
  void api
    .aiPing()
    .then(() => {
      aiAvailable.value = true;
    })
    .catch(() => undefined);

  void loadCompletionLists();

  window.addEventListener('keydown', onGlobalKey);
  draftTimer = window.setInterval(autosaveDraft, 10000);

  if (isNew.value) {
    form.value.status = 'draft';
    form.value.date = localDateTimeValue(new Date());
    draftFound.value = readDraft();
    await nextTick();
    autosize();
    return;
  }
  try {
    const { post } = await api.getPost(id.value);
    fillForm(post);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '加载文章失败');
    void router.replace({ name: 'posts' });
  } finally {
    loading.value = false;
  }
  draftFound.value = readDraft();
  await nextTick();
  autosize();
});

onUnmounted(() => {
  if (draftTimer) window.clearInterval(draftTimer);
  window.removeEventListener('keydown', onGlobalKey);
});
</script>

<template>
  <div v-if="loading" class="grid place-items-center py-24 text-ink-muted">
    <Loader2 :size="22" class="animate-spin" />
  </div>

  <div v-else class="pb-20">
    <!-- 顶部操作条 -->
    <div class="editor-topbar sticky top-16 z-10 py-3 mb-5
                border-b border-line bg-canvas/85 backdrop-blur-md flex items-center gap-2 flex-wrap">
      <button class="btn btn-ghost btn-sm" @click="router.push({ name: 'posts' })">
        <ArrowLeft :size="16" />
        返回
      </button>

      <span class="text-[13px] text-ink-muted hidden sm:inline">
        {{ isNew ? '新文章' : `ID：${id}` }}
      </span>

      <div class="ml-auto flex items-center gap-2">
        <button v-if="!isNew" class="btn btn-ghost btn-sm" title="修订历史" @click="openRevisions">
          <History :size="15" />
          <span class="hidden sm:inline">修订历史</span>
        </button>

        <button v-if="!isNew" class="btn btn-ghost btn-sm" title="生成预览链接" @click="openPreviewLink">
          <Link2 :size="15" />
          <span class="hidden sm:inline">预览链接</span>
        </button>

        <a
          v-if="!isNew && form.status === 'published'"
          class="btn btn-ghost btn-sm"
          :href="`/posts/${encodeURIComponent(id)}/`"
          target="_blank"
          rel="noopener"
        >
          <ExternalLink :size="15" />
          <span class="hidden sm:inline">查看</span>
        </a>

        <button v-if="!isNew" class="btn btn-ghost btn-sm hover:text-danger" @click="remove">
          <Trash2 :size="15" />
        </button>

        <button class="btn btn-secondary btn-sm" :disabled="saving" @click="save('draft')">
          <span>存为草稿</span>
        </button>

        <button class="btn btn-primary btn-sm" :disabled="saving" @click="save('published')">
          <Loader2 v-if="saving" :size="15" class="animate-spin" />
          <Save v-else :size="15" />
          <span>{{ saving ? '保存中…' : '发布' }}</span>
        </button>
      </div>
    </div>

    <div class="grid gap-6 lg:grid-cols-[1fr_320px] items-start">
      <!-- 主区 -->
      <div class="space-y-4 min-w-0">
        <input
          v-model="form.title"
          class="input input-lg !text-[19px] !font-semibold !h-auto !py-3"
          placeholder="文章标题"
        />

        <div class="card overflow-hidden">
        <!-- 本地草稿提示（崩溃 / 误关后可恢复） -->
        <div
          v-if="draftFound"
          class="flex items-center gap-2 flex-wrap border-b border-line bg-surface-2 px-3 py-2.5"
        >
          <span class="flex items-center gap-1.5 text-[13px] text-ink-soft">
            <Save :size="14" />
            发现 {{ formatDateTime(draftFound.savedAt) }} 自动保存的本地草稿
          </span>
          <div class="ml-auto flex items-center gap-1.5">
            <button class="btn btn-sm btn-secondary" @click="restoreDraft">
              <Undo2 :size="14" />
              恢复草稿
            </button>
            <button class="btn btn-sm btn-ghost" @click="discardDraft">丢弃草稿</button>
          </div>
        </div>

        <!-- AI 写作助手：服务端未配置 AI 时整块隐藏 -->
        <div v-if="aiAvailable" class="card p-3.5 space-y-3">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-[13px] font-semibold text-ink-soft flex items-center gap-1.5">
              <Sparkles :size="15" class="text-[var(--accent)]" />
              AI 写作助手
            </span>

            <select v-model="aiLang" class="select !w-auto !py-1 !text-[12.5px]">
              <option value="zh-CN">中文</option>
              <option value="en">English</option>
              <option value="ja">日本語</option>
              <option value="ko">한국어</option>
              <option value="hi">हिन्दी</option>
            </select>

            <div class="ml-auto flex items-center gap-1.5 flex-wrap">
              <button
                v-for="item in aiActions"
                :key="item.key"
                class="btn btn-sm"
                :class="aiAction === item.key && aiResult ? 'btn-secondary' : 'btn-ghost'"
                :disabled="aiBusy"
                @click="aiRun(item.key)"
              >
                <Loader2 v-if="aiBusy && aiAction === item.key" :size="13" class="animate-spin" />
                {{ item.label }}
              </button>
            </div>
          </div>

          <p class="hint -mt-1">标题与标签基于当前填写内容，润色、翻译作用于正文。</p>

          <p v-if="aiError" class="text-[12.5px] text-danger">{{ aiError }}</p>

          <div v-if="aiResult" class="rounded-xl border border-line bg-surface-2 p-3 space-y-2">
            <div
              class="max-h-44 overflow-auto text-[13px] leading-[1.7] break-words whitespace-pre-wrap"
            >{{ aiResult }}</div>
            <div class="flex items-center gap-1.5 flex-wrap">
              <button class="btn btn-sm btn-primary" @click="aiApply('replace')">
                <Check :size="14" />
                应用
              </button>
              <button
                v-if="aiAction === 'polish' || aiAction === 'translate'"
                class="btn btn-sm btn-secondary"
                @click="aiApply('append')"
              >
                追加到末尾
              </button>
              <button class="btn btn-sm btn-ghost" @click="copyText(aiResult)">
                <Copy :size="14" />
                复制
              </button>
              <button class="btn btn-sm btn-ghost" @click="aiResult = ''; aiError = ''">收起</button>
            </div>
          </div>
        </div>

          <!-- 编辑模式切换 -->
          <div class="flex items-center gap-1 px-2 py-1.5 border-b border-line bg-surface-2">
            <button
              v-for="tab in ([
                ['write', '编辑', Pencil],
                ['split', '分栏', Columns2],
                ['preview', '预览', Eye]
              ] as const)"
              :key="tab[0]"
              class="btn btn-sm"
              :class="mode === tab[0] ? 'btn-secondary' : 'btn-ghost'"
              @click="mode = tab[0]"
            >
              <component :is="tab[2]" :size="14" />
              <span class="hidden sm:inline">{{ tab[1] }}</span>
            </button>
          </div>

          <div class="grid" :class="mode === 'split' ? 'md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-line' : ''">
            <!-- 写作区：Markdown 工具栏 + textarea + 统计 -->
            <div v-if="mode !== 'preview'" class="flex min-w-0 flex-col">
              <div class="flex flex-wrap items-center gap-0.5 border-b border-line bg-surface-2 px-2 py-1.5">
                <button class="btn btn-sm btn-ghost !px-1.5" title="加粗" @mousedown.prevent="insertMd('bold')">
                  <Bold :size="15" />
                </button>
                <button class="btn btn-sm btn-ghost !px-1.5" title="斜体" @mousedown.prevent="insertMd('italic')">
                  <Italic :size="15" />
                </button>
                <button class="btn btn-sm btn-ghost !px-1.5" title="删除线" @mousedown.prevent="insertMd('strike')">
                  <Strikethrough :size="15" />
                </button>
                <button class="btn btn-sm btn-ghost !px-1.5" title="标题" @mousedown.prevent="insertMd('h')">
                  <Heading :size="15" />
                </button>
                <button class="btn btn-sm btn-ghost !px-1.5" title="引用" @mousedown.prevent="insertMd('quote')">
                  <Quote :size="15" />
                </button>
                <button class="btn btn-sm btn-ghost !px-1.5" title="行内代码" @mousedown.prevent="insertMd('code')">
                  <Code :size="15" />
                </button>
                <button class="btn btn-sm btn-ghost !px-1.5" title="无序列表" @mousedown.prevent="insertMd('ul')">
                  <List :size="15" />
                </button>
                <button class="btn btn-sm btn-ghost !px-1.5" title="有序列表" @mousedown.prevent="insertMd('ol')">
                  <ListOrdered :size="15" />
                </button>
                <button class="btn btn-sm btn-ghost !px-1.5" title="任务清单" @mousedown.prevent="insertMd('task')">
                  <ListChecks :size="15" />
                </button>
                <button class="btn btn-sm btn-ghost !px-1.5" title="链接" @mousedown.prevent="insertMd('link')">
                  <Link :size="15" />
                </button>
                <button class="btn btn-sm btn-ghost !px-1.5" title="图片" @mousedown.prevent="insertMd('img')">
                  <Image :size="15" />
                </button>
                <button class="btn btn-sm btn-ghost !px-1.5" title="双链 [[ ]]" @mousedown.prevent="insertMd('wiki')">
                  <span class="text-[13px] font-semibold">[[ ]]</span>
                </button>
                <button class="btn btn-sm btn-ghost !px-1.5" title="表格" @mousedown.prevent="insertMd('table')">
                  <Table :size="15" />
                </button>
                <button class="btn btn-sm btn-ghost !px-1.5" title="分割线" @mousedown.prevent="insertMd('hr')">
                  <Minus :size="15" />
                </button>
                <button class="btn btn-sm btn-ghost !px-1.5" title="代码块" @mousedown.prevent="insertMd('codeblock')">
                  <span class="text-[12px] font-semibold">{ }</span>
                </button>
                <select
                  v-model="mdLang"
                  class="select !h-8 !w-auto !py-0.5 !text-[12px]"
                  title="代码块语言"
                >
                  <option v-for="opt in mdLangOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                </select>
                <button
                  class="btn btn-sm btn-ghost !px-1.5"
                  :class="emojiOpen ? 'btn-secondary' : ''"
                  title="插入表情"
                  @mousedown.prevent="emojiOpen = !emojiOpen"
                >
                  <Smile :size="15" />
                </button>
              </div>

              <!-- 表情面板：内联展开，避免被卡片的 overflow-hidden 裁切 -->
              <div
                v-if="emojiOpen"
                class="grid max-h-40 grid-cols-8 gap-0.5 overflow-auto border-b border-line bg-surface px-2 py-2
                       sm:grid-cols-12"
              >
                <button
                  v-for="emoji in EMOJIS"
                  :key="emoji"
                  class="rounded-md py-1 text-[16px] leading-none hover:bg-surface-2"
                  @mousedown.prevent="insertEmoji(emoji)"
                >{{ emoji }}</button>
              </div>

              <textarea
                ref="textareaRef"
                v-model="form.content"
                class="w-full min-h-[480px] p-4 bg-transparent border-0 resize-none outline-none
                       font-mono text-[13.5px] leading-[1.75] focus:ring-0 overflow-hidden"
                placeholder="用 Markdown 写正文…&#10;&#10;# 一级标题&#10;&#10;**加粗**、`代码`、[链接](https://example.com)"
                spellcheck="false"
                @input="onContentInput"
                @paste="onContentPaste"
                @keydown="onContentKeydown"
              />

              <div
                class="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[12px] text-ink-muted tabular-nums"
              >
                <span>
                  {{ editorStats.lines }} 行 · {{ editorStats.chars }} 字符 ·
                  {{ editorStats.words }} 词 · 约 {{ editorStats.minutes }} 分钟
                </span>
                <span v-if="pasting" class="text-[var(--accent)]">图片上传中…</span>
                <span class="ml-auto hidden sm:inline">Ctrl/⌘+B 加粗 · I 斜体 · K 链接 · S 保存</span>
              </div>
            </div>

            <div v-if="mode !== 'write'" class="min-h-[480px] p-5 overflow-x-auto">
              <div v-if="!form.content" class="text-[13px] text-ink-muted">预览会显示在这里</div>
              <div v-else class="prose-qingyu" v-html="rendered" />
            </div>
          </div>

          <div class="flex items-center gap-2 border-t border-line px-3 py-2 text-[12px] text-ink-muted">
            <span v-if="draftSavedAt">本地草稿已自动保存：{{ formatDateTime(draftSavedAt) }}</span>
            <span v-else>编辑中每 10 秒自动保存本地草稿（加密文章不保存），崩溃后可恢复。</span>
          </div>
        </div>
      </div>

      <!-- 侧栏 -->
      <aside class="space-y-4 lg:sticky lg:top-32">
        <!-- 发布 -->
        <section class="card p-4 space-y-3.5">
          <h2 class="text-[13px] font-semibold text-ink-soft">发布</h2>

          <div>
            <label class="label">状态</label>
            <select v-model="form.status" class="select">
              <option value="draft">草稿</option>
              <option value="published">已发布</option>
              <option value="scheduled">定时发布</option>
            </select>
          </div>

          <div v-if="form.status === 'scheduled'">
            <label class="label">
              <CalendarClock :size="13" class="inline -mt-0.5 mr-1" />发布时间
            </label>
            <input v-model="form.publishAt" type="datetime-local" step="60" class="input" />
            <p class="hint">按站点时区（默认 UTC）到点自动发布。</p>
          </div>

          <label class="flex items-center gap-2 text-[13px] cursor-pointer select-none">
            <input v-model="form.pinned" type="checkbox" class="accent-[var(--accent)] size-4" />
            置顶显示
          </label>

          <label class="flex items-center gap-2 text-[13px] cursor-pointer select-none">
            <input v-model="form.protected" type="checkbox" class="accent-[var(--accent)] size-4" />
            <Lock :size="14" />
            加密文章
          </label>

          <!-- 文章加密：密码输入 + 已加密文章的解锁 -->
          <div v-if="form.protected" class="space-y-2">
            <div class="flex items-center gap-2">
              <input
                v-model="protectPwd"
                :type="pwdVisible ? 'text' : 'password'"
                class="input text-[13px]"
                maxlength="64"
                placeholder="访问密码"
                autocomplete="new-password"
              />
              <button class="btn btn-sm btn-secondary shrink-0" title="显示 / 隐藏密码" @click="pwdVisible = !pwdVisible">
                <Eye :size="14" />
              </button>
            </div>
            <button
              v-if="hasEnc"
              class="btn btn-sm btn-secondary w-full"
              :disabled="unlocking"
              @click="unlockEncrypted"
            >
              <Loader2 v-if="unlocking" :size="14" class="animate-spin" />
              <Unlock v-else :size="14" />
              <span>{{ unlocking ? '解锁中…' : '用密码解锁正文' }}</span>
            </button>
            <p class="hint">
              {{
                hasEnc
                  ? unlocked
                    ? '正文已解锁，保存时将用密码重新加密。'
                    : '正文已加密，需解锁后才能编辑；密码仅存本机，忘记将无法恢复。'
                  : '开启后前台需输入密码才能阅读正文，正文不再以明文保存。'
              }}
            </p>
          </div>

          <div v-if="isNew">
            <label class="label" for="postId">文章 ID（URL 别名）</label>
            <input
              id="postId"
              v-model="form.id"
              class="input font-mono text-[13px]"
              placeholder="hello-world"
              @input="idTouched = true"
            />
            <p class="hint">文章地址为 /posts/&lt;ID&gt;/，发布后不建议修改。</p>
          </div>
        </section>

        <!-- 封面 -->
        <section class="card p-4 space-y-3">
          <h2 class="text-[13px] font-semibold text-ink-soft">封面</h2>
          <div
            v-if="form.cover"
            class="relative rounded-xl overflow-hidden border border-line aspect-[16/9] bg-surface-2 group"
          >
            <img :src="form.cover" alt="" class="size-full object-cover" />
            <button
              class="absolute top-2 right-2 btn btn-sm bg-black/55 text-white backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity"
              @click="form.cover = ''"
            >
              移除
            </button>
          </div>
          <label class="block">
            <input v-model="form.cover" class="input text-[13px]" placeholder="图片地址 /media/…" />
          </label>
          <input
            ref="fileInput"
            type="file"
            accept="image/*"
            class="hidden"
            @change="(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) uploadCover(f) }"
          />
          <div class="grid grid-cols-2 gap-2">
            <button class="btn btn-secondary btn-sm" :disabled="uploading" @click="fileInput?.click()">
              <Loader2 v-if="uploading" :size="15" class="animate-spin" />
              <ImagePlus v-else :size="15" />
              <span>{{ uploading ? '上传中…' : '上传图片' }}</span>
            </button>
            <button class="btn btn-secondary btn-sm" @click="openMediaPicker('cover')">
              <Images :size="15" />
              媒体库
            </button>
          </div>

          <!-- 分享图（OG） -->
          <div class="space-y-3 border-t border-line pt-3">
            <div class="flex items-center justify-between gap-2">
              <h3 class="text-[13px] font-semibold text-ink-soft">分享图（OG）</h3>
              <label class="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-soft">
                <input v-model="ogAuto" type="checkbox" class="accent-[var(--accent)]" />
                保存时自动生成
              </label>
            </div>
            <div
              v-if="form.ogImage"
              class="group relative aspect-[16/9] overflow-hidden rounded-xl border border-line bg-surface-2"
            >
              <img :src="form.ogImage" alt="分享图预览" class="size-full object-cover" />
              <button
                class="absolute top-2 right-2 btn btn-sm bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100"
                @click="form.ogImage = ''"
              >
                移除
              </button>
            </div>
            <p v-else class="hint">还没有分享图，社交平台抓取时会退回到封面或默认卡片。</p>
            <div class="grid grid-cols-2 gap-2">
              <button
                class="btn btn-secondary btn-sm"
                :disabled="ogGenerating || saving"
                @click="generateOg"
              >
                <Loader2 v-if="ogGenerating" :size="15" class="animate-spin" />
                <Wand v-else :size="15" />
                <span>{{ ogGenerating ? '生成中…' : form.ogImage ? '重新生成' : '生成分享图' }}</span>
              </button>
              <button class="btn btn-secondary btn-sm" @click="openMediaPicker('ogImage')">
                <Images :size="15" />
                媒体库
              </button>
            </div>
            <p class="hint">画布 1200×630，按标题 / 日期 / 标签 / 系列自动生成；勾选上方选项后，保存文章时内容变了会自动重画。</p>
          </div>
        </section>

        <!-- 属性 -->
        <section class="card p-4 space-y-3.5">
          <h2 class="text-[13px] font-semibold text-ink-soft">属性</h2>

          <div>
            <label class="label">
              <CalendarClock :size="13" class="inline -mt-0.5 mr-1" />日期
            </label>
            <div class="flex items-center gap-2">
              <input v-model="form.date" type="datetime-local" step="60" class="input" />
              <button class="btn btn-sm btn-secondary shrink-0" @click="setNow">设为现在</button>
            </div>
            <p class="hint">文章发布日期，影响列表排序与分享图落款。</p>
          </div>

          <div>
            <label class="label">摘要</label>
            <textarea v-model="form.excerpt" class="textarea" rows="3" placeholder="列表页与分享卡片使用" />
          </div>

          <div>
            <label class="label">标签</label>
            <input v-model="form.tags" class="input" placeholder="用逗号分隔" />
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="label">分类</label>
              <input v-model="form.category" class="input" list="categoryOptions" placeholder="可选" />
              <datalist id="categoryOptions">
                <option v-for="c in categoryOptions" :key="c" :value="c" />
              </datalist>
            </div>
            <div>
              <label class="label">作者</label>
              <input v-model="form.author" class="input" list="authorOptions" placeholder="留空=站点署名" />
              <datalist id="authorOptions">
                <option v-for="a in authorOptions" :key="a" :value="a" />
              </datalist>
            </div>
          </div>

          <div>
            <label class="label">系列</label>
            <div class="flex items-center gap-2">
              <input v-model="form.series" class="input" placeholder="可选，用于系列文章" />
              <input
                v-model.number="form.seriesOrder"
                type="number"
                min="0"
                step="1"
                class="input !w-24 shrink-0"
                placeholder="序号"
                title="系列内序号"
              />
            </div>
            <p class="hint">同一系列内按序号从 0 升序排列。</p>
          </div>
        </section>

        <!-- SEO -->
        <section class="card p-4 space-y-3.5">
          <h2 class="text-[13px] font-semibold text-ink-soft">SEO 覆盖</h2>
          <p class="text-[12px] text-ink-muted -mt-1">留空则自动生成标题、描述与 canonical。</p>

          <div>
            <label class="label">SEO 标题</label>
            <input v-model="form.seo.title" class="input" placeholder="默认：标题 · 站点名" />
          </div>
          <div>
            <label class="label">SEO 描述</label>
            <textarea v-model="form.seo.desc" class="textarea" rows="2" placeholder="默认：摘要或正文前 200 字" />
          </div>
          <div>
            <label class="label">Canonical</label>
            <input v-model="form.seo.canonical" class="input font-mono text-[12px]" placeholder="https://…" />
          </div>
          <label class="flex items-center gap-2 text-[13px] cursor-pointer select-none">
            <input v-model="form.seo.noindex" type="checkbox" class="accent-[var(--accent)] size-4" />
            不被搜索引擎索引
          </label>
        </section>
      </aside>
    </div>

      <!-- 修订历史 -->
      <div
        v-if="revOpen"
        class="fixed inset-0 z-50 bg-black/45 backdrop-blur-sm p-4 grid place-items-center"
        @click.self="revOpen = false"
      >
        <div class="card w-full max-w-4xl max-h-[86vh] flex flex-col overflow-hidden">
          <header class="flex items-center gap-2 px-4 py-3 border-b border-line">
            <History :size="16" class="text-ink-muted" />
            <h2 class="text-[14px] font-semibold">修订历史</h2>
            <span class="badge">{{ revisions.length }} 条</span>
            <button class="btn btn-sm btn-ghost ml-auto" title="关闭" @click="revOpen = false">
              <X :size="16" />
            </button>
          </header>

          <div class="grid md:grid-cols-[260px_1fr] min-h-0 flex-1">
            <!-- 左：版本列表 -->
            <div class="border-b md:border-b-0 md:border-r border-line overflow-y-auto max-h-[60vh]">
              <button
                v-for="r in revisions"
                :key="r.id"
                class="w-full text-left px-3 py-2.5 border-b border-line last:border-b-0 transition-colors"
                :class="revSelected === r.id ? 'bg-surface-2' : 'hover:bg-surface-2'"
                @click="selectRevision(r.id)"
              >
                <div class="flex items-center gap-2">
                  <span class="badge" :class="r.reason === 'create' ? 'badge-info' : ''">
                    {{ revisionReasonLabel(r.reason) }}
                  </span>
                  <span class="ml-auto text-[11.5px] text-ink-muted tabular-nums">
                    {{ formatDateTime(r.createdAt) }}
                  </span>
                </div>
                <div class="text-[12.5px] text-ink-soft truncate mt-1">{{ r.title || '（无标题）' }}</div>
              </button>
              <div v-if="!revLoading && !revisions.length" class="p-4 text-[13px] text-ink-muted">
                暂无修订记录，保存一次文章后会自动生成。
              </div>
            </div>

            <!-- 右：版本详情与差异 -->
            <div class="overflow-y-auto p-4 space-y-3 max-h-[60vh]">
              <div v-if="revLoading" class="grid place-items-center py-10 text-ink-muted">
                <Loader2 :size="20" class="animate-spin" />
              </div>

              <template v-else-if="revDetail">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-[13.5px] font-semibold truncate">{{ revDetail.title || '（无标题）' }}</span>
                  <span class="badge">{{ formatDateTime(revDetail.createdAt) }}</span>
                  <span class="badge badge-info">{{ revisionReasonLabel(revDetail.reason) }}</span>
                  <span class="badge" :class="revDetail.status === 'published' ? 'badge-success' : 'badge-warning'">
                    {{ revDetail.status === 'published' ? '已发布' : revDetail.status === 'scheduled' ? '定时发布' : '草稿' }}
                  </span>
                </div>

                <div class="flex items-center gap-2 flex-wrap">
                  <button class="btn btn-sm btn-primary" :disabled="revRestoring" @click="restoreRevision">
                    <Loader2 v-if="revRestoring" :size="14" class="animate-spin" />
                    <Undo2 v-else :size="14" />
                    <span>{{ revRestoring ? '恢复中…' : '恢复此版本' }}</span>
                  </button>
                  <span class="hint">恢复前会先把当前内容存为一条修订，随时可以再切回来。</span>
                </div>

                <div>
                  <h3 class="text-[12.5px] font-semibold text-ink-soft mb-1.5">与当前编辑内容的差异</h3>
                  <div class="rounded-xl border border-line bg-surface-2 overflow-hidden max-h-72 overflow-auto">
                    <div
                      v-for="(line, i) in diffLines"
                      :key="i"
                      class="px-3 font-mono text-[12px] leading-[1.7] whitespace-pre-wrap break-words"
                      :class="
                        line.type === 'add'
                          ? 'bg-success-soft text-success'
                          : line.type === 'del'
                            ? 'bg-danger-soft text-danger'
                            : 'text-ink-muted'
                      "
                    >
                      <span class="inline-block w-3 select-none opacity-50">{{
                        line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '
                      }}</span>{{ line.text }}
                    </div>
                    <div v-if="!diffLines.length" class="px-3 py-3 text-[12.5px] text-ink-muted">两边内容一致。</div>
                  </div>
                </div>
              </template>

              <div v-else class="py-8 text-center text-[13px] text-ink-muted">选择左侧的版本查看详情。</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 媒体库选择器 -->
      <div
        v-if="mediaOpen"
        class="fixed inset-0 z-50 bg-black/45 backdrop-blur-sm p-4 grid place-items-center"
        @click.self="mediaOpen = false"
      >
        <div class="card w-full max-w-3xl max-h-[80vh] flex flex-col overflow-hidden">
          <header class="flex items-center gap-2 border-b border-line px-4 py-3">
            <Images :size="16" class="text-ink-muted" />
            <h2 class="text-[14px] font-semibold">
              从媒体库选择{{ mediaTarget === 'cover' ? '封面' : '分享图' }}
            </h2>
            <button class="btn btn-sm btn-ghost ml-auto" title="关闭" @click="mediaOpen = false">
              <X :size="16" />
            </button>
          </header>

          <div class="overflow-y-auto p-4">
            <div v-if="mediaLoading" class="grid place-items-center py-12 text-ink-muted">
              <Loader2 :size="20" class="animate-spin" />
            </div>
            <div v-else-if="!mediaList.length" class="py-12 text-center text-[13px] text-ink-muted">
              媒体库还没有图片，先上传一张吧。
            </div>
            <div v-else class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              <button
                v-for="m in mediaList"
                :key="m.id"
                class="overflow-hidden rounded-xl border border-line bg-surface-2 text-left transition-colors hover:border-[var(--accent)]"
                @click="pickMedia(m)"
              >
                <div class="aspect-[4/3] overflow-hidden bg-surface">
                  <img :src="m.thumb_url || m.url" alt="" class="size-full object-cover" />
                </div>
                <div class="truncate px-2 py-1.5 text-[12px] text-ink-soft">{{ m.name || '未命名' }}</div>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 预览链接 -->
      <div
        v-if="pvOpen"
        class="fixed inset-0 z-50 bg-black/45 backdrop-blur-sm p-4 grid place-items-center"
        @click.self="pvOpen = false"
      >
        <div class="card w-full max-w-lg p-4 space-y-3">
          <div class="flex items-center gap-2">
            <Link2 :size="16" class="text-ink-muted" />
            <h2 class="text-[14px] font-semibold">预览链接</h2>
            <button class="btn btn-sm btn-ghost ml-auto" title="关闭" @click="pvOpen = false">
              <X :size="16" />
            </button>
          </div>

          <p class="hint -mt-1">凭链接可在发布前查看文章，7 天后自动失效，可随时重新生成。</p>

          <div v-if="pvLoading" class="grid place-items-center py-6 text-ink-muted">
            <Loader2 :size="20" class="animate-spin" />
          </div>

          <template v-else>
            <input :value="pvUrl" readonly class="input font-mono text-[12.5px]" />
            <div class="flex items-center gap-2 flex-wrap">
              <button class="btn btn-sm btn-primary" @click="copyText(pvUrl)">
                <Copy :size="14" />
                复制链接
              </button>
              <a class="btn btn-sm btn-secondary" :href="pvUrl" target="_blank" rel="noopener">
                <ExternalLink :size="14" />
                打开预览
              </a>
              <span class="hint ml-auto">有效期至 {{ formatDateTime(pvExpires) }}</span>
            </div>
          </template>
        </div>
      </div>
  </div>
</template>

<style scoped>
/* 吸顶操作条要横向铺满整个内容区、盖住 .admin-content 的左右装订线。
 * 负边距与内边距都读同一个变量 --content-gutter（在 style.css 的 .admin-content
 * 上定义，窄屏会变成 18px）：写死 -mx-8/px-8 的话，桌面端 32px 比实际装订线 30px
 * 多 2px，就会把文档撑出横向滚动。 */
.editor-topbar {
  margin-left: calc(var(--content-gutter, 30px) * -1);
  margin-right: calc(var(--content-gutter, 30px) * -1);
  padding-left: var(--content-gutter, 30px);
  padding-right: var(--content-gutter, 30px);
}
</style>
