<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  Save, Loader2, ArrowLeft, Eye, Pencil, Columns2, ImagePlus, ExternalLink, Trash2, CalendarClock,
  History, Link2, Sparkles, Copy, X, Undo2, Check, Wand
} from '@lucide/vue';
import {
  api, uploadTo, ApiError,
  type Seo, type PostDetail, type PostRevisionMeta, type PostRevisionDetail
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
const mode = ref<'write' | 'split' | 'preview'>('split');
const fileInput = ref<HTMLInputElement | null>(null);

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
  author: '',
  status: 'draft' as 'published' | 'draft' | 'scheduled',
  publishAt: '' as string,
  pinned: false,
  seo: { title: '', desc: '', canonical: '', noindex: false } as Seo
});

/* ---------- 预览：marked 渲染 + DOMPurify 消毒 ---------- */
const rendered = ref('');
const renderPreview = debounce((markdown: string) => {
  const html = marked.parse(markdown || '', { async: false }) as string;
  rendered.value = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}, 180);

watch(() => form.value.content, (value) => renderPreview(value), { immediate: true });

/* ---------- 载入 ---------- */
function fillForm(post: PostDetail): void {
  form.value = {
    id: post.id,
    title: post.title,
    excerpt: post.excerpt,
    content: post.content,
    cover: post.cover || post.ogImage || '',
    ogImage: post.ogImage || '',
    date: post.date || '',
    tags: (post.tags ?? []).join(', '),
    category: post.category ?? '',
    series: post.series ?? '',
    author: post.author ?? '',
    status: (post.status ?? 'draft') as typeof form.value.status,
    publishAt: post.publishAt ? new Date(post.publishAt).toISOString().slice(0, 16) : '',
    pinned: post.pinned,
    seo: { title: '', desc: '', canonical: '', noindex: false, ...(post.seo ?? {}) }
  };
  ogSource.value = ogFingerprint();
}

onMounted(async () => {
  // 站点名用于分享图落款；设置接口异常时用默认名兜底
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
    })
    .catch(() => undefined);

  // AI 是否可用：服务端没配置 AI 时接口返回 404，AI 功能整块自动隐藏
  void api
    .aiPing()
    .then(() => {
      aiAvailable.value = true;
    })
    .catch(() => undefined);

  if (isNew.value) {
    form.value.status = 'draft';
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
});

/* 新建时用标题自动生成 id（用户改过就不再覆盖） */
const idTouched = ref(false);
watch(
  () => form.value.title,
  (title) => {
    if (!isNew.value || idTouched.value) return;
    form.value.id = slugify(title);
  }
);


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

/* ---------- 保存 ---------- */
const payload = computed(() => ({
  title: form.value.title.trim(),
  excerpt: form.value.excerpt.trim(),
  content: form.value.content,
  cover: form.value.cover.trim(),
  ogImage: form.value.ogImage.trim(),
  tags: form.value.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
  category: form.value.category.trim(),
  series: form.value.series.trim(),
  author: form.value.author.trim(),
  status: form.value.status,
  pinned: form.value.pinned,
  seo: form.value.seo,
  ...(form.value.status === 'scheduled' && form.value.publishAt
    ? { publishAt: new Date(form.value.publishAt).getTime() }
    : {}),
  // 新建时若正文为空，给个占位避免出现空内容文章
  ...(isNew.value ? { date: new Date().toISOString() } : {})
}));

async function save(nextStatus?: typeof form.value.status): Promise<void> {
  if (nextStatus) form.value.status = nextStatus;
  if (!payload.value.title) {
    toast.error('请填写标题');
    return;
  }
  if (isNew.value && !form.value.id.trim()) {
    toast.error('请填写文章 ID（URL 别名）');
    return;
  }

  saving.value = true;
  try {
    if (isNew.value && !form.value.date) form.value.date = new Date().toISOString();
    const fingerprint = ogFingerprint();
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    if (ogAuto.value && online && (!form.value.ogImage || ogSource.value !== fingerprint)) {
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
    if (isNew.value) {
      await api.createPost({ ...payload.value, id: form.value.id.trim() });
      toast.success('已创建');
      await router.replace({ name: 'post-edit', params: { id: form.value.id.trim() } });
    } else {
      await api.updatePost(id.value, payload.value);
      toast.success('已保存');
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

async function remove(): Promise<void> {
  if (!window.confirm('确定删除这篇文章？')) return;
  try {
    await api.deletePost(id.value);
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

</script>

<template>
  <div v-if="loading" class="grid place-items-center py-24 text-ink-muted">
    <Loader2 :size="22" class="animate-spin" />
  </div>

  <div v-else class="pb-20">
    <!-- 顶部操作条 -->
    <div class="sticky top-16 z-10 -mx-4 lg:-mx-8 px-4 lg:px-8 py-3 mb-5
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
            <pre class="whitespace-pre-wrap break-words max-h-44 overflow-auto text-[13px] leading-[1.7]">{{ aiResult }}</pre>
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

          <!-- 编辑器工具条 -->
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
            <span class="ml-auto text-[12px] text-ink-muted px-2 tabular-nums">
              {{ form.content.length }} 字
            </span>
          </div>

          <div class="grid" :class="mode === 'split' ? 'md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-line' : ''">
            <textarea
              v-if="mode !== 'preview'"
              v-model="form.content"
              class="w-full min-h-[540px] p-4 bg-transparent border-0 resize-none outline-none
                     font-mono text-[13.5px] leading-[1.75] focus:ring-0"
              placeholder="用 Markdown 写正文…&#10;&#10;# 一级标题&#10;&#10;**加粗**、`代码`、[链接](https://example.com)"
              spellcheck="false"
            />
            <div
              v-if="mode !== 'write'"
              class="min-h-[540px] p-5 overflow-x-auto"
            >
              <div v-if="!form.content" class="text-[13px] text-ink-muted">预览会显示在这里</div>
              <div v-else class="prose-qingyu" v-html="rendered" />
            </div>
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
            <input v-model="form.publishAt" type="datetime-local" class="input" />
            <p class="hint">按站点时区（默认 UTC）到点自动发布。</p>
          </div>

          <label class="flex items-center gap-2 text-[13px] cursor-pointer select-none">
            <input v-model="form.pinned" type="checkbox" class="accent-[var(--accent)] size-4" />
            置顶显示
          </label>

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
          <button class="btn btn-secondary w-full btn-sm" :disabled="uploading" @click="fileInput?.click()">
            <Loader2 v-if="uploading" :size="15" class="animate-spin" />
            <ImagePlus v-else :size="15" />
            <span>{{ uploading ? '上传中…' : '上传图片' }}</span>
          </button>

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
            <button
              class="btn btn-secondary w-full btn-sm"
              :disabled="ogGenerating || saving"
              @click="generateOg"
            >
              <Loader2 v-if="ogGenerating" :size="15" class="animate-spin" />
              <Wand v-else :size="15" />
              <span>{{ ogGenerating ? '生成中…' : form.ogImage ? '重新生成分享图' : '生成分享图' }}</span>
            </button>
            <p class="hint">画布 1200×630，按标题 / 日期 / 标签 / 系列自动生成；勾选上方选项后，保存文章时内容变了会自动重画。</p>
          </div>
        </section>

        <!-- 属性 -->
        <section class="card p-4 space-y-3.5">
          <h2 class="text-[13px] font-semibold text-ink-soft">属性</h2>

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
              <input v-model="form.category" class="input" />
            </div>
            <div>
              <label class="label">作者</label>
              <input v-model="form.author" class="input" />
            </div>
          </div>

          <div>
            <label class="label">系列</label>
            <input v-model="form.series" class="input" placeholder="可选，用于系列文章" />
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
