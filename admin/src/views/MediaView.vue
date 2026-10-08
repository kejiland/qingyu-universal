<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  UploadCloud, Loader2, Trash2, Copy, FileCode, Check, ImageOff, Search, X, ChevronLeft, ChevronRight
} from '@lucide/vue';
import { api, uploadTo, ApiError, type MediaItem } from '../lib/api';
import { formatBytes, formatDate } from '../lib/format';
import { toast } from '../lib/toast';
import { compressImageFile } from '../lib/image';

const PER_PAGE = 24;

const items = ref<MediaItem[]>([]);
const loading = ref(true);
const uploading = ref(false);
const progress = ref(0);
const dragging = ref(false);
const keyword = ref('');
const copied = ref<string | null>(null);
const page = ref(1);
const selected = ref<Set<string>>(new Set());
const fileInput = ref<HTMLInputElement | null>(null);

/* 灯箱 */
const lightboxId = ref<string | null>(null);

const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase();
  if (!q) return items.value;
  return items.value.filter((item) => item.name.toLowerCase().includes(q));
});

const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / PER_PAGE)));

const pageItems = computed(() => {
  const current = Math.min(page.value, totalPages.value);
  return filtered.value.slice((current - 1) * PER_PAGE, current * PER_PAGE);
});

const allSelected = computed(
  () => filtered.value.length > 0 && filtered.value.every((item) => selected.value.has(item.id))
);

/* 灯箱当前项与序号 */
const lightboxIndex = computed(() => filtered.value.findIndex((item) => item.id === lightboxId.value));
const lightboxItem = computed(() => (lightboxIndex.value >= 0 ? filtered.value[lightboxIndex.value] : null));

async function load(): Promise<void> {
  loading.value = true;
  try {
    const data = await api.listMedia();
    items.value = data.media ?? [];
    selected.value = new Set();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '加载媒体库失败');
  } finally {
    loading.value = false;
  }
}

function pick(files: FileList | null | undefined): void {
  if (!files?.length) return;
  void uploadFiles(Array.from(files));
}

async function uploadFiles(files: File[]): Promise<void> {
  const images = files.filter((file) => file.type.startsWith('image/'));
  if (!images.length) {
    toast.error('只支持图片文件');
    return;
  }

  uploading.value = true;
  progress.value = 0;
  let done = 0;
  try {
    for (const file of images) {
      // 先压缩主图并生成缩略图（与上游 uploadImageAsset 同逻辑）
      const packed = await compressImageFile(file);
      const mainFile = packed.file;
      if (mainFile.size > 10 * 1024 * 1024) {
        toast.error(`${file.name} 超过 10MB，已跳过`);
        continue;
      }

      const ticket = await api.uploadTicket(mainFile.name, mainFile.size, !!packed.thumb);
      await uploadTo(ticket.uploadUrl, mainFile, ticket.contentType || mainFile.type, (percent) => {
        progress.value = Math.round(((done + percent / 100) / images.length) * 100);
      });

      /* 缩略图必须真的把字节 PUT 上去。
       * 之前这里只登记了 thumbUrl 却没上传内容，thumb_url 指向空对象 ——
       * 上传当次列表用原图还能看，刷新后改读 thumb_url 就 404。
       * 只有上传成功才把 thumbUrl 登记进去，否则让列表回退到原图。 */
      let thumbOk = false;
      if (packed.thumb && ticket.thumbUploadUrl) {
        try {
          await uploadTo(ticket.thumbUploadUrl, packed.thumb, 'image/webp');
          thumbOk = true;
        } catch {
          thumbOk = false;
        }
      }

      await api.registerMedia({
        name: mainFile.name,
        url: ticket.publicUrl,
        type: ticket.contentType || mainFile.type,
        size: mainFile.size,
        ...(thumbOk && ticket.thumbPublicUrl ? { thumbUrl: ticket.thumbPublicUrl } : {})
      });
      done += 1;
    }
    // 重新拉取：拿到的才是服务端的真实记录（上游也是上传完 loadMedia 重载）
    await load();
    toast.success(`已上传 ${done} 张图片`);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '上传失败');
    await load();
  } finally {
    uploading.value = false;
    progress.value = 0;
    if (fileInput.value) fileInput.value.value = '';
  }
}

function toggle(id: string): void {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

function toggleAll(): void {
  selected.value = allSelected.value ? new Set() : new Set(filtered.value.map((item) => item.id));
}

async function remove(item: MediaItem): Promise<void> {
  if (!window.confirm(`删除「${item.name}」？已引用该图片的文章会出现空图。`)) return;
  try {
    await api.deleteMedia(item.id);
    items.value = items.value.filter((entry) => entry.id !== item.id);
    selected.value.delete(item.id);
    if (lightboxId.value === item.id) closeLightbox();
    toast.success('已删除');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '删除失败');
  }
}

/* 批量删除：逐条请求，统计成功 / 失败 */
async function batchDelete(): Promise<void> {
  const ids = [...selected.value];
  if (!ids.length) return;
  if (!window.confirm(`确定删除选中的 ${ids.length} 张图片？已引用它们的文章会出现空图。`)) return;

  let ok = 0;
  let fail = 0;
  for (const id of ids) {
    try {
      await api.deleteMedia(id);
      ok += 1;
    } catch {
      fail += 1;
    }
  }
  if (ok) toast.success(`已删除 ${ok} 张${fail ? `，${fail} 张失败` : ''}`);
  else toast.error('删除失败');
  if (lightboxId.value && ids.includes(lightboxId.value)) closeLightbox();
  await load();
}

/* 写入剪贴板：优先 Clipboard API，不可用时降级到 execCommand。
 * 自托管站点常常是 http://IP 或 http://域名，不是安全上下文，
 * navigator.clipboard 直接不存在 —— 只用它会一直提示「复制失败，请手动选择」。
 * 上游 admin.js 的 copyText() 也是同样的两段式降级。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 权限被拒或非安全上下文，走下面的降级 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // 不要让它闪一下：移出视口但保持可选中
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/* 复制图片直链（绝对地址） */
async function copy(url: string): Promise<void> {
  const absolute = url.startsWith('http') ? url : `${location.origin}${url}`;
  if (!(await copyText(absolute))) {
    toast.error('复制失败，请手动选择');
    return;
  }
  copied.value = url;
  window.setTimeout(() => {
    if (copied.value === url) copied.value = null;
  }, 1600);
}

/* 复制 Markdown：![name](url) */
async function copyMarkdown(item: MediaItem): Promise<void> {
  const url = item.url.startsWith('http') ? item.url : `${location.origin}${item.url}`;
  if (!(await copyText(`![${item.name}](${url})`))) {
    toast.error('复制失败，请手动选择');
    return;
  }
  toast.success('已复制 Markdown');
}

/* ---------- 预览：缩略图取不到就回退原图 ----------
 * 早期版本登记了 thumbUrl 却没上传内容，库里可能残留指向空对象的 thumb_url。
 * 这里在 onerror 时记下来，改用原图，老数据也能正常显示。 */
const brokenThumbs = ref<Set<string>>(new Set());

function previewUrl(item: MediaItem): string {
  if (brokenThumbs.value.has(item.id)) return item.url;
  return item.thumb_url || item.url;
}

function onThumbError(item: MediaItem): void {
  if (brokenThumbs.value.has(item.id)) return;
  const next = new Set(brokenThumbs.value);
  next.add(item.id);
  brokenThumbs.value = next;
}

/* ---------- 灯箱：放大预览 + 左右翻页 + Esc 关闭 ---------- */
function openLightbox(id: string): void {
  lightboxId.value = id;
}

function closeLightbox(): void {
  lightboxId.value = null;
}

function stepLightbox(delta: number): void {
  const list = filtered.value;
  if (!list.length || lightboxIndex.value < 0) return;
  const next = (lightboxIndex.value + delta + list.length) % list.length;
  lightboxId.value = list[next].id;
}

function onKeydown(e: KeyboardEvent): void {
  if (!lightboxId.value) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') stepLightbox(-1);
  else if (e.key === 'ArrowRight') stepLightbox(1);
}

onMounted(() => {
  void load();
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div>
    <!-- 上传区 -->
    <div
      class="card mb-5 p-6 border-dashed transition-colors cursor-pointer text-center"
      :class="dragging ? 'border-accent bg-accent-soft' : 'hover:border-line-strong'"
      @click="fileInput?.click()"
      @dragenter.prevent="dragging = true"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="dragging = false; pick($event.dataTransfer?.files)"
    >
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        multiple
        class="hidden"
        @change="(e) => pick((e.target as HTMLInputElement).files)"
      />

      <span class="grid place-items-center size-11 rounded-2xl bg-surface-2 text-accent mx-auto mb-3">
        <Loader2 v-if="uploading" :size="20" class="animate-spin" />
        <UploadCloud v-else :size="20" />
      </span>

      <p class="text-sm font-medium">{{ uploading ? `上传中… ${progress}%` : '点击或拖拽图片到此处上传' }}</p>
      <p class="text-[12px] text-ink-muted mt-1">支持 PNG / JPG / WebP / GIF / SVG / AVIF，单张不超过 10MB</p>

      <div v-if="uploading" class="mt-4 h-1 rounded-full bg-surface-3 overflow-hidden">
        <div class="h-full bg-accent transition-all duration-200" :style="{ width: `${progress}%` }" />
      </div>
    </div>

    <!-- 搜索 -->
    <div v-if="items.length > 0" class="relative mb-4">
      <Search :size="16" class="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none" />
      <input v-model="keyword" class="input pl-9" type="search" placeholder="搜索文件名…" @input="page = 1" />
    </div>

    <!-- 选择 / 批量操作条 -->
    <div v-if="!loading && filtered.length > 0" class="mb-4 flex items-center gap-3 flex-wrap">
      <label class="flex items-center gap-2 text-[12.5px] text-ink-muted cursor-pointer select-none">
        <input
          type="checkbox"
          class="accent-[var(--accent)] size-4"
          :checked="allSelected"
          @change="toggleAll"
        />
        全选当前结果
      </label>
      <span v-if="selected.size > 0" class="text-[12.5px] text-accent font-medium">已选 {{ selected.size }} 张</span>
      <button
        class="btn btn-sm btn-danger ml-auto"
        :disabled="selected.size === 0"
        @click="batchDelete"
      >
        <Trash2 :size="14" /> 批量删除
      </button>
    </div>

    <!-- 骨架 -->
    <div v-if="loading" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
      <div v-for="i in 8" :key="i" class="card aspect-square shimmer" />
    </div>

    <!-- 空状态 -->
    <div v-else-if="filtered.length === 0" class="card py-16 flex flex-col items-center text-center">
      <span class="grid place-items-center size-12 rounded-2xl bg-surface-2 text-ink-muted mb-3">
        <ImageOff :size="22" />
      </span>
      <p class="text-sm font-medium">{{ items.length === 0 ? '媒体库还是空的' : '没有匹配的图片' }}</p>
      <p class="text-[13px] text-ink-muted mt-1">
        {{ items.length === 0 ? '上传的图片会保存在这里，可随时插入文章。' : '换个关键词试试。' }}
      </p>
    </div>

    <!-- 网格 -->
    <template v-else>
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        <figure
          v-for="item in pageItems"
          :key="item.id"
          class="card group overflow-hidden"
          :class="selected.has(item.id) ? 'ring-2 ring-accent' : ''"
        >
          <div class="relative aspect-square bg-surface-2">
            <img
              :src="previewUrl(item)"
              :alt="item.name"
              class="size-full object-cover cursor-zoom-in"
              loading="lazy"
              @click="openLightbox(item.id)"
              @error="onThumbError(item)"
            />

            <!-- 选择框 -->
            <label class="absolute top-2 left-2 z-10 grid place-items-center size-6 rounded-md bg-black/35 backdrop-blur-sm cursor-pointer">
              <input
                type="checkbox"
                class="accent-[var(--accent)] size-4"
                :checked="selected.has(item.id)"
                @change="toggle(item.id)"
              />
            </label>

            <div class="absolute inset-0 bg-black/45 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1.5 pointer-events-none">
              <button
                class="btn btn-sm bg-white/15 text-white backdrop-blur-sm pointer-events-auto"
                title="复制 Markdown"
                @click="copyMarkdown(item)"
              >
                <FileCode :size="14" /> MD
              </button>
              <button
                class="btn btn-sm bg-white/15 text-white backdrop-blur-sm pointer-events-auto"
                @click="copy(item.url)"
              >
                <Check v-if="copied === item.url" :size="14" />
                <Copy v-else :size="14" />
                <span>{{ copied === item.url ? '已复制' : '链接' }}</span>
              </button>
              <button
                class="btn btn-sm bg-white/15 text-white backdrop-blur-sm hover:bg-danger pointer-events-auto"
                title="删除"
                @click="remove(item)"
              >
                <Trash2 :size="14" />
              </button>
            </div>
          </div>
          <figcaption class="p-2.5">
            <p class="text-[12.5px] truncate" :title="item.name">{{ item.name }}</p>
            <p class="text-[11px] text-ink-muted mt-0.5">
              {{ formatBytes(item.size) }} · {{ formatDate(item.created_at) }}
            </p>
          </figcaption>
        </figure>
      </div>

      <!-- 分页 -->
      <div v-if="totalPages > 1" class="flex items-center justify-between mt-4">
        <span class="text-[12.5px] text-ink-muted">
          第 {{ Math.min(page, totalPages) }} / {{ totalPages }} 页 · 共 {{ filtered.length }} 张
        </span>
        <div class="flex items-center gap-1.5">
          <button class="btn btn-sm btn-ghost btn-icon" :disabled="page <= 1" title="上一页" @click="page -= 1">
            <ChevronLeft :size="16" />
          </button>
          <button
            class="btn btn-sm btn-ghost btn-icon"
            :disabled="page >= totalPages"
            title="下一页"
            @click="page += 1"
          >
            <ChevronRight :size="16" />
          </button>
        </div>
      </div>
    </template>

    <!-- 灯箱预览 -->
    <div
      v-if="lightboxItem"
      class="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm p-4 grid place-items-center"
      role="dialog"
      aria-modal="true"
      @click.self="closeLightbox"
    >
      <button class="absolute top-4 right-4 btn btn-sm bg-white/15 text-white backdrop-blur-sm" title="关闭" @click="closeLightbox">
        <X :size="18" />
      </button>
      <button
        v-if="filtered.length > 1"
        class="absolute left-4 top-1/2 -translate-y-1/2 btn btn-sm bg-white/15 text-white backdrop-blur-sm"
        title="上一张"
        @click="stepLightbox(-1)"
      >
        <ChevronLeft :size="20" />
      </button>
      <img
        :src="lightboxItem.url || lightboxItem.thumb_url"
        :alt="lightboxItem.name"
        class="max-h-[85vh] max-w-[90vw] object-contain rounded-lg"
        @click.self="closeLightbox"
      />
      <button
        v-if="filtered.length > 1"
        class="absolute right-4 top-1/2 -translate-y-1/2 btn btn-sm bg-white/15 text-white backdrop-blur-sm"
        title="下一张"
        @click="stepLightbox(1)"
      >
        <ChevronRight :size="20" />
      </button>
      <div class="absolute bottom-5 left-1/2 -translate-x-1/2 text-[12.5px] text-white/80 tabular-nums">
        {{ lightboxItem.name }} · {{ lightboxIndex + 1 }} / {{ filtered.length }}
      </div>
    </div>
  </div>
</template>
