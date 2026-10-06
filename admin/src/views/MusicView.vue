<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  UploadCloud, Loader2, Trash2, Pencil, Search, Music, Play, Pause,
  ChevronLeft, ChevronRight, Check, X, Disc3
} from '@lucide/vue';
import { api, uploadTo, ApiError, type MusicTrack } from '../lib/api';
import { formatBytes } from '../lib/format';
import { toast } from '../lib/toast';

const AUDIO_EXTS = ['mp3', 'm4a', 'ogg', 'wav', 'aac', 'opus', 'flac'];
const MAX_SIZE = 30 * 1024 * 1024;
const PER_PAGE = 15;

const tracks = ref<MusicTrack[]>([]);
const loading = ref(true);
const keyword = ref('');
const page = ref(1);

const dragging = ref(false);
const uploading = ref(false);
const progress = ref(0);
const picked = ref<File | null>(null);
const title = ref('');
const artist = ref('');
const fileInput = ref<HTMLInputElement | null>(null);

const editingId = ref<string | null>(null);
const editTitle = ref('');
const editArtist = ref('');
const busyId = ref<string | null>(null);

/* ---------- 共享播放器：同一时刻只播一首 ---------- */
const audio = new Audio();
audio.preload = 'none';
const playingId = ref<string | null>(null);
const currentUrl = ref('');
const currentTime = ref(0);
const duration = ref(0);

audio.addEventListener('timeupdate', () => {
  currentTime.value = audio.currentTime;
});
audio.addEventListener('loadedmetadata', () => {
  duration.value = Number.isFinite(audio.duration) ? audio.duration : 0;
});
audio.addEventListener('ended', () => {
  playingId.value = null;
  currentTime.value = 0;
  duration.value = 0;
});

onBeforeUnmount(() => {
  audio.pause();
  audio.removeAttribute('src');
});

const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase();
  if (!q) return tracks.value;
  return tracks.value.filter((track) =>
    `${track.title} ${track.artist}`.toLowerCase().includes(q)
  );
});

const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / PER_PAGE)));

const pageItems = computed(() => {
  const current = Math.min(page.value, totalPages.value);
  return filtered.value.slice((current - 1) * PER_PAGE, current * PER_PAGE);
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const data = await api.listMusic();
    tracks.value = data.music ?? [];
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '加载歌单失败');
  } finally {
    loading.value = false;
  }
}

/* ---------- 从文件名解析「歌名-歌手」：歌手取最后一段 ---------- */
function parseName(name: string): { title: string; artist: string } {
  const base = String(name || '').replace(/\.[^.]+$/, '');
  const idx = base.lastIndexOf('-');
  if (idx > 0) {
    const partTitle = base.slice(0, idx).trim();
    const partArtist = base.slice(idx + 1).trim();
    if (partTitle && partArtist) return { title: partTitle, artist: partArtist };
  }
  return { title: base, artist: '' };
}

function accept(file: File | null | undefined): File | null {
  if (!file) return null;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!AUDIO_EXTS.includes(ext)) {
    toast.error('只支持 mp3 / m4a / ogg / wav / aac / opus / flac');
    return null;
  }
  if (file.size > MAX_SIZE) {
    toast.error('单曲不能超过 30MB');
    return null;
  }
  return file;
}

function pick(files: FileList | null | undefined): void {
  const file = accept(files?.[0]);
  if (!file) return;
  picked.value = file;
  const parsed = parseName(file.name);
  title.value = parsed.title;
  artist.value = parsed.artist;
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  const file = accept(event.dataTransfer?.files?.[0]);
  if (!file) return;
  picked.value = file;
  const parsed = parseName(file.name);
  title.value = parsed.title;
  artist.value = parsed.artist;
  void upload();
}

async function upload(): Promise<void> {
  const file = picked.value;
  if (!file) {
    toast.error('请先选择音频文件');
    return;
  }
  const finalTitle = title.value.trim() || parseName(file.name).title || file.name;
  const finalArtist = artist.value.trim() || parseName(file.name).artist;

  uploading.value = true;
  progress.value = 0;
  try {
    const ticket = await api.musicUploadTicket(file.name, file.size);
    await uploadTo(ticket.uploadUrl, file, ticket.contentType || file.type || 'audio/mpeg', (percent) => {
      progress.value = percent;
    });
    await api.registerMusic({
      title: finalTitle,
      artist: finalArtist,
      url: ticket.publicUrl,
      size: file.size
    });
    progress.value = 100;
    toast.success('已加入歌单');
    picked.value = null;
    title.value = '';
    artist.value = '';
    if (fileInput.value) fileInput.value.value = '';
    await load();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '上传失败');
  } finally {
    uploading.value = false;
    progress.value = 0;
  }
}

/* ---------- 播放 ---------- */
function absolute(url: string): string {
  if (!url) return '';
  try {
    return new URL(url, location.origin).href;
  } catch {
    return url;
  }
}

function toggle(track: MusicTrack): void {
  const href = absolute(track.url);
  if (!href) {
    toast.error('该曲目没有可用地址');
    return;
  }
  if (playingId.value === track.id && !audio.paused) {
    audio.pause();
    playingId.value = null;
    return;
  }
  if (currentUrl.value !== href) {
    currentUrl.value = href;
    audio.src = href;
    currentTime.value = 0;
    duration.value = 0;
  }
  void audio
    .play()
    .then(() => {
      playingId.value = track.id;
    })
    .catch(() => {
      playingId.value = null;
      toast.error('播放失败，请检查音频文件是否可访问');
    });
}

function seek(event: MouseEvent, track: MusicTrack): void {
  if (playingId.value !== track.id || !duration.value) return;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  audio.currentTime = ratio * duration.value;
  currentTime.value = audio.currentTime;
}

function fmtTime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

const progressPercent = computed(() =>
  duration.value > 0 ? Math.min(100, (currentTime.value / duration.value) * 100) : 0
);

/* ---------- 编辑 / 删除 ---------- */
function startEdit(track: MusicTrack): void {
  editingId.value = track.id;
  editTitle.value = track.title;
  editArtist.value = track.artist || '';
}

async function saveEdit(track: MusicTrack): Promise<void> {
  const nextTitle = editTitle.value.trim();
  if (!nextTitle) {
    toast.error('歌名不能为空');
    return;
  }
  busyId.value = track.id;
  try {
    await api.updateMusic(track.id, { title: nextTitle, artist: editArtist.value.trim() });
    editingId.value = null;
    toast.success('已保存');
    await load();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '保存失败');
  } finally {
    busyId.value = null;
  }
}

async function remove(track: MusicTrack): Promise<void> {
  if (!window.confirm(`删除「${track.title}」？该曲目会从歌单与存储中一并移除。`)) return;
  busyId.value = track.id;
  try {
    await api.deleteMusic(track.id);
    tracks.value = tracks.value.filter((item) => item.id !== track.id);
    toast.success('已删除');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '删除失败');
  } finally {
    busyId.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <!-- 上传区 -->
    <section class="card mb-5 p-5">
      <div class="flex items-start gap-3 mb-4">
        <span class="grid place-items-center size-9 rounded-xl bg-accent-soft text-accent shrink-0">
          <UploadCloud :size="18" />
        </span>
        <div>
          <h2 class="text-[14.5px] font-semibold">上传音乐</h2>
          <p class="text-[12.5px] text-ink-muted mt-0.5">
            选择或拖拽音频文件，歌名与歌手会按「歌名-歌手」自动填好
          </p>
        </div>
      </div>

      <div
        class="rounded-xl border border-dashed px-4 py-5 text-center cursor-pointer transition-colors"
        :class="dragging ? 'border-accent bg-accent-soft' : 'border-line-strong hover:border-accent/60'"
        @click="fileInput?.click()"
        @dragenter.prevent="dragging = true"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        <input
          ref="fileInput"
          type="file"
          accept="audio/*"
          class="hidden"
          @change="pick(($event.target as HTMLInputElement).files)"
        />
        <p class="text-[13.5px] font-medium truncate">
          {{ picked ? picked.name : '点击选择或拖拽音频到此处' }}
        </p>
        <p class="text-[12px] text-ink-muted mt-1">
          支持 mp3 / m4a / ogg / wav / aac / opus / flac，单曲不超过 30MB
        </p>
      </div>

      <div class="flex flex-wrap gap-2 mt-3">
        <input v-model="title" class="input flex-1 min-w-[180px]" placeholder="歌名" autocomplete="off" />
        <input v-model="artist" class="input flex-1 min-w-[140px]" placeholder="歌手" autocomplete="off" />
        <button class="btn btn-primary" :disabled="uploading || !picked" @click="upload">
          <Loader2 v-if="uploading" :size="16" class="animate-spin" />
          <UploadCloud v-else :size="16" />
          {{ uploading ? `上传中… ${progress}%` : '上传到歌单' }}
        </button>
      </div>

      <div v-if="uploading" class="mt-3 h-1 rounded-full bg-surface-3 overflow-hidden">
        <div class="h-full bg-accent transition-all duration-200" :style="{ width: `${progress}%` }" />
      </div>

      <p class="hint">上传走对象存储 / 本地磁盘直传，文件不会经过后台中转。</p>
    </section>

    <!-- 搜索 -->
    <div v-if="tracks.length > 0" class="relative mb-4">
      <Search :size="16" class="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none" />
      <input v-model="keyword" class="input pl-9" type="search" placeholder="搜索歌名或歌手…" @input="page = 1" />
    </div>

    <!-- 骨架 -->
    <div v-if="loading" class="space-y-2.5">
      <div v-for="i in 5" :key="i" class="card h-16 shimmer" />
    </div>

    <!-- 空状态 -->
    <div v-else-if="filtered.length === 0" class="card py-16 flex flex-col items-center text-center">
      <span class="grid place-items-center size-12 rounded-2xl bg-surface-2 text-ink-muted mb-3">
        <Disc3 :size="22" />
      </span>
      <p class="text-sm font-medium">{{ tracks.length === 0 ? '歌单还是空的' : '没有匹配的曲目' }}</p>
      <p class="text-[13px] text-ink-muted mt-1">
        {{ tracks.length === 0 ? '上传第一首歌，前台音乐播放器就能用起来了。' : '换个关键词试试。' }}
      </p>
    </div>

    <!-- 列表 -->
    <div v-else class="card divide-y divide-line overflow-hidden">
      <div v-for="track in pageItems" :key="track.id" class="flex items-center gap-3 px-4 py-3">
        <!-- 封面 / 占位 -->
        <span class="grid place-items-center size-9 rounded-lg bg-surface-2 text-ink-muted overflow-hidden shrink-0">
          <img v-if="track.cover" :src="track.cover" alt="" class="size-full object-cover" loading="lazy" />
          <Music v-else :size="16" />
        </span>

        <!-- 信息（编辑态换成输入框） -->
        <div v-if="editingId === track.id" class="flex-1 min-w-0 flex flex-wrap gap-2">
          <input v-model="editTitle" class="input flex-1 min-w-[160px]" placeholder="歌名" />
          <input v-model="editArtist" class="input flex-1 min-w-[120px]" placeholder="歌手" />
        </div>
        <div v-else class="flex-1 min-w-0">
          <p class="text-[13.5px] font-medium truncate">{{ track.title }}</p>
          <p class="text-[12px] text-ink-muted mt-0.5 truncate">{{ track.artist || '未知歌手' }}</p>

          <!-- 播放进度 -->
          <div v-if="playingId === track.id" class="mt-1.5 flex items-center gap-2 max-w-[340px]">
            <div
              class="h-1 flex-1 rounded-full bg-surface-3 overflow-hidden cursor-pointer"
              @click="seek($event, track)"
            >
              <div class="h-full bg-accent transition-[width] duration-150" :style="{ width: `${progressPercent}%` }" />
            </div>
            <span class="text-[11px] tabular-nums text-ink-muted shrink-0">
              {{ fmtTime(currentTime) }} / {{ fmtTime(duration) }}
            </span>
          </div>
        </div>

        <!-- 操作 -->
        <div class="flex items-center gap-1.5 shrink-0">
          <span class="hidden sm:inline badge badge-neutral">{{ formatBytes(track.size) }}</span>

          <template v-if="editingId === track.id">
            <button
              class="btn btn-sm btn-primary"
              :disabled="busyId === track.id"
              @click="saveEdit(track)"
            >
              <Loader2 v-if="busyId === track.id" :size="14" class="animate-spin" />
              <Check v-else :size="14" />
              保存
            </button>
            <button class="btn btn-sm btn-ghost" @click="editingId = null">
              <X :size="14" />
              取消
            </button>
          </template>

          <template v-else>
            <button
              class="btn btn-sm btn-secondary btn-icon"
              :title="playingId === track.id ? '暂停' : '试听'"
              @click="toggle(track)"
            >
              <Pause v-if="playingId === track.id" :size="15" />
              <Play v-else :size="15" />
            </button>
            <button class="btn btn-sm btn-ghost btn-icon" title="编辑" @click="startEdit(track)">
              <Pencil :size="15" />
            </button>
            <button
              class="btn btn-sm btn-ghost btn-icon text-danger"
              title="删除"
              :disabled="busyId === track.id"
              @click="remove(track)"
            >
              <Loader2 v-if="busyId === track.id" :size="15" class="animate-spin" />
              <Trash2 v-else :size="15" />
            </button>
          </template>
        </div>
      </div>

      <!-- 分页 -->
      <div v-if="totalPages > 1" class="flex items-center justify-between px-4 py-3">
        <span class="text-[12.5px] text-ink-muted">
          第 {{ Math.min(page, totalPages) }} / {{ totalPages }} 页 · 共 {{ filtered.length }} 首
        </span>
        <div class="flex items-center gap-1.5">
          <button
            class="btn btn-sm btn-ghost btn-icon"
            :disabled="page <= 1"
            title="上一页"
            @click="page -= 1"
          >
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
    </div>
  </div>
</template>