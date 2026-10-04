<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { UploadCloud, Loader2, Trash2, Copy, Check, ImageOff, Search } from '@lucide/vue';
import { api, uploadTo, ApiError, type MediaItem } from '../lib/api';
import { formatBytes, formatDate } from '../lib/format';
import { toast } from '../lib/toast';

const items = ref<MediaItem[]>([]);
const loading = ref(true);
const uploading = ref(false);
const progress = ref(0);
const dragging = ref(false);
const keyword = ref('');
const copied = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase();
  if (!q) return items.value;
  return items.value.filter((item) => item.name.toLowerCase().includes(q));
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const data = await api.listMedia();
    items.value = data.media ?? [];
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
      if (file.size > 10 * 1024 * 1024) {
        toast.error(`${file.name} 超过 10MB，已跳过`);
        continue;
      }
      const ticket = await api.uploadTicket(file.name, file.size, true);
      await uploadTo(ticket.uploadUrl, file, ticket.contentType || file.type, (percent) => {
        progress.value = Math.round(((done + percent / 100) / images.length) * 100);
      });
      if (ticket.thumbUploadUrl) {
        // 缩略图由后端签发独立地址，这里让服务端生成更稳妥，暂不前端压缩
      }
      const { media } = await api.registerMedia({
        name: file.name,
        url: ticket.publicUrl,
        type: ticket.contentType || file.type,
        size: file.size,
        ...(ticket.thumbPublicUrl ? { thumbUrl: ticket.thumbPublicUrl } : {})
      });
      items.value = [media, ...items.value];
      done += 1;
    }
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

async function remove(item: MediaItem): Promise<void> {
  if (!window.confirm(`删除「${item.name}」？已引用该图片的文章会出现空图。`)) return;
  try {
    await api.deleteMedia(item.id);
    items.value = items.value.filter((entry) => entry.id !== item.id);
    toast.success('已删除');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '删除失败');
  }
}

async function copy(url: string): Promise<void> {
  const absolute = url.startsWith('http') ? url : `${location.origin}${url}`;
  try {
    await navigator.clipboard.writeText(absolute);
  } catch {
    toast.error('复制失败，请手动选择');
    return;
  }
  copied.value = url;
  window.setTimeout(() => {
    if (copied.value === url) copied.value = null;
  }, 1600);
}

onMounted(load);
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
      <input v-model="keyword" class="input pl-9" type="search" placeholder="搜索文件名…" />
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
    <div v-else class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
      <figure
        v-for="item in filtered"
        :key="item.id"
        class="card group overflow-hidden"
      >
        <div class="relative aspect-square bg-surface-2">
          <img
            :src="item.thumb_url || item.url"
            :alt="item.name"
            class="size-full object-cover"
            loading="lazy"
          />
          <div class="absolute inset-0 bg-black/45 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1.5">
            <button class="btn btn-sm bg-white/15 text-white backdrop-blur-sm" @click="copy(item.url)">
              <Check v-if="copied === item.url" :size="14" />
              <Copy v-else :size="14" />
              <span>{{ copied === item.url ? '已复制' : '复制链接' }}</span>
            </button>
            <button
              class="btn btn-sm bg-white/15 text-white backdrop-blur-sm hover:bg-danger"
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
  </div>
</template>