<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  FileDown, FileUp, Loader2, Search, FileText, Inbox, UploadCloud, PackageOpen, FileJson, Globe, FolderOpen
} from '@lucide/vue';
import { api, ApiError, type PostSummary } from '../lib/api';
import { postStatusMeta, formatDate } from '../lib/format';
import { toast } from '../lib/toast';
import {
  backupJson, downloadBlob, downloadText, parseJson, parseMarkdown, postToMarkdown,
  readFileText, stamp, toSlug, zipForPosts, type TransferPost
} from '../lib/transfer';

/** full=1 返回正文与密文，生成类型里没声明，用本地形态补上。 */
type FullPost = PostSummary & { content?: string; enc?: unknown };

const posts = ref<FullPost[]>([]);
const loading = ref(true);
const keyword = ref('');
const busy = ref(false);
const statusText = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const folderInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);
const selected = ref<Set<string>>(new Set());

const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase();
  if (!q) return posts.value;
  return posts.value.filter((post) =>
    `${post.title} ${(post.tags ?? []).join(' ')}`.toLowerCase().includes(q)
  );
});

const selectedPosts = computed(() => posts.value.filter((post) => selected.value.has(post.id)));
const allSelected = computed(() => filtered.value.length > 0 && filtered.value.every((post) => selected.value.has(post.id)));
const someSelected = computed(() => selected.value.size > 0 && !allSelected.value);

function toggleSelect(id: string, checked: boolean): void {
  const next = new Set(selected.value);
  if (checked) next.add(id);
  else next.delete(id);
  selected.value = next;
}

function toggleAll(checked: boolean): void {
  const next = new Set(selected.value);
  filtered.value.forEach((post) => {
    if (checked) next.add(post.id);
    else next.delete(post.id);
  });
  selected.value = next;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    // full=1：一次拿回草稿 + 正文，避免导出时逐篇请求
    const data = await api.listPosts({ full: true });
    posts.value = (data.posts ?? []) as FullPost[];
    selected.value = new Set();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '加载文章失败');
  } finally {
    loading.value = false;
  }
}

function asTransfer(list: FullPost[]): TransferPost[] {
  return list as unknown as TransferPost[];
}

/* ------------------------------------------------------------
 * 导出
 * ------------------------------------------------------------ */

async function exportZip(): Promise<void> {
  if (!posts.value.length) {
    toast.error('还没有可导出的文章');
    return;
  }
  busy.value = true;
  statusText.value = '正在打包 Markdown…';
  try {
    const list = asTransfer(posts.value);
    downloadBlob(`qingyu-posts-${stamp()}.zip`, zipForPosts(list));
    toast.success(`已导出 ${list.length} 篇文章`);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '导出失败');
  } finally {
    busy.value = false;
    statusText.value = '';
  }
}

async function exportJson(): Promise<void> {
  if (!posts.value.length) {
    toast.error('还没有可导出的文章');
    return;
  }
  busy.value = true;
  statusText.value = '正在生成备份 JSON…';
  try {
    const list = asTransfer(posts.value);
    downloadText(`qingyu-backup-${stamp()}.json`, backupJson(list), 'application/json;charset=utf-8');
    toast.success(`已导出 ${list.length} 篇文章`);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '导出失败');
  } finally {
    busy.value = false;
    statusText.value = '';
  }
}

async function exportStaticSite(): Promise<void> {
  busy.value = true;
  statusText.value = '正在生成静态站…';
  try {
    const { name, blob } = await api.exportStaticSite();
    downloadBlob(name, blob);
    toast.success('静态站已导出，上传 ZIP 里的全部文件即可');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '导出失败');
  } finally {
    busy.value = false;
    statusText.value = '';
  }
}

/** 只导出勾选的文章为 Markdown ZIP。 */
async function exportSelected(): Promise<void> {
  if (!selectedPosts.value.length) {
    toast.error('请先勾选要导出的文章');
    return;
  }
  busy.value = true;
  statusText.value = '正在打包选中文章…';
  try {
    const list = asTransfer(selectedPosts.value);
    downloadBlob(`qingyu-posts-${stamp()}.zip`, zipForPosts(list));
    toast.success(`已导出 ${list.length} 篇文章`);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '导出失败');
  } finally {
    busy.value = false;
    statusText.value = '';
  }
}

function exportOne(post: FullPost): void {
  const name = `${toSlug(post.title || post.id) || 'post'}.md`;
  downloadText(name, postToMarkdown(post as unknown as TransferPost));
  toast.success(`已导出《${post.title}》`);
}

/* ------------------------------------------------------------
 * 导入
 * ------------------------------------------------------------ */

async function importFiles(files: FileList | null | undefined): Promise<void> {
  const list = Array.from(files ?? []).filter((file) => /\.(md|markdown|json)$/i.test(file.name));
  if (!list.length) {
    toast.error('只支持 .md / .markdown / .json 文件');
    return;
  }

  busy.value = true;
  statusText.value = '正在读取文件…';
  const parsed: TransferPost[] = [];
  let failed = 0;

  try {
    for (const file of list) {
      try {
        const text = await readFileText(file);
        const items = /\.json$/i.test(file.name) ? parseJson(text) : [parseMarkdown(text, file.name)];
        items.forEach((item) => {
          if (item) parsed.push(item);
        });
      } catch {
        failed += 1;
      }
    }

    if (!parsed.length) {
      toast.error('没有解析出可导入的文章');
      return;
    }

    // 批次内去重：同名 ID 自动加序号，避免互相覆盖
    const used: Record<string, boolean> = {};
    parsed.forEach((post) => {
      const base = post.id;
      let n = 2;
      while (used[post.id]) {
        post.id = `${base}-${n}`;
        n += 1;
      }
      used[post.id] = true;
    });

    const existing: Record<string, boolean> = {};
    try {
      const current = await api.listPosts({ all: true });
      (current.posts ?? []).forEach((post) => {
        existing[post.id] = true;
      });
    } catch {
      /* 拿不到已有列表就按新建处理 */
    }

    const conflicts = parsed.filter((post) => existing[post.id]);
    if (conflicts.length) {
      const ok = window.confirm(
        `有 ${conflicts.length} 篇文章的 ID 与现有文章重复，继续导入会覆盖这些文章。\n\n是否继续？`
      );
      if (!ok) {
        toast.info('已取消导入');
        return;
      }
    }

    let done = 0;
    for (const post of parsed) {
      statusText.value = `正在导入 ${done + 1} / ${parsed.length}：${post.title}`;
      try {
        if (existing[post.id]) await api.updatePost(post.id, post);
        else await api.createPost(post);
        done += 1;
      } catch {
        failed += 1;
      }
    }

    if (done) toast.success(`已导入 ${done} 篇文章`);
    if (failed) toast.error(`${failed} 个文件或条目导入失败`);
    await load();
  } finally {
    busy.value = false;
    statusText.value = '';
    if (fileInput.value) fileInput.value.value = '';
    if (folderInput.value) folderInput.value.value = '';
  }
}

function pick(files: FileList | null | undefined): void {
  if (!files?.length) return;
  void importFiles(files);
}

/** 文件夹选择：webkitdirectory 会递归带上子目录里的文件。 */
function pickFolder(files: FileList | null | undefined): void {
  if (!files?.length) return;
  void importFiles(files);
}

onMounted(load);
</script>

<template>
  <div>
    <!-- 导出 / 导入 -->
    <div class="grid gap-4 md:grid-cols-2 mb-5">
      <!-- 导出 -->
      <section class="card p-5">
        <div class="flex items-start gap-3 mb-4">
          <span class="grid place-items-center size-9 rounded-xl bg-accent-soft text-accent shrink-0">
            <FileDown :size="18" />
          </span>
          <div>
            <h2 class="text-[14.5px] font-semibold">导出文章</h2>
            <p class="text-[12.5px] text-ink-muted mt-0.5">与原版同一套格式，可直接导入回原版</p>
          </div>
        </div>

        <div class="flex flex-col gap-2">
          <button class="btn btn-primary w-full" :disabled="busy || loading || !posts.length" @click="exportZip">
            <Loader2 v-if="busy && statusText.includes('打包')" :size="16" class="animate-spin" />
            <PackageOpen v-else :size="16" />
            全部导出为 Markdown（ZIP）
          </button>
          <button class="btn btn-secondary w-full" :disabled="busy || loading || !posts.length" @click="exportJson">
            <Loader2 v-if="busy && statusText.includes('JSON')" :size="16" class="animate-spin" />
            <FileJson v-else :size="16" />
            导出备份 JSON
          </button>
          <button class="btn btn-secondary w-full" :disabled="busy || loading || !posts.length" @click="exportStaticSite">
            <Loader2 v-if="busy && statusText.includes('静态站')" :size="16" class="animate-spin" />
            <Globe v-else :size="16" />
            导出静态站（ZIP）
          </button>
        </div>

        <p class="hint">
          ZIP 内每篇文章一个 <code>.md</code>，另附 <code>posts.json</code>；
          JSON 是整站文章备份，两种文件都能再导回来。
        </p>

        <p class="hint">
          静态站是整站快照：上传 ZIP 里的全部文件即可，无需服务端。
          它不含图片与音频本体，纯静态下自定义导航/页脚会回到默认值。
        </p>
      </section>

      <!-- 导入 -->
      <section class="card p-5">
        <div class="flex items-start gap-3 mb-4">
          <span class="grid place-items-center size-9 rounded-xl bg-accent-soft text-accent shrink-0">
            <FileUp :size="18" />
          </span>
          <div>
            <h2 class="text-[14.5px] font-semibold">导入文章</h2>
            <p class="text-[12.5px] text-ink-muted mt-0.5">支持一次拖入多个 Markdown / JSON 文件</p>
          </div>
        </div>

        <div
          class="rounded-xl border border-dashed px-4 py-6 text-center cursor-pointer transition-colors"
          :class="dragging ? 'border-accent bg-accent-soft' : 'border-line-strong hover:border-accent/60'"
          @click="fileInput?.click()"
          @dragenter.prevent="dragging = true"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="dragging = false; pick($event.dataTransfer?.files)"
        >
          <input
            ref="fileInput"
            type="file"
            accept=".md,.markdown,.json"
            multiple
            class="hidden"
            @change="pick(($event.target as HTMLInputElement).files)"
          />
          <UploadCloud :size="20" class="mx-auto text-ink-muted mb-2" />
          <p class="text-[13.5px] font-medium">点击选择或拖拽文件到此处</p>
          <p class="text-[12px] text-ink-muted mt-1">.md / .markdown / .json，可多选</p>
        </div>

        <div class="flex items-center gap-2 mt-3">
          <button class="btn btn-ghost btn-sm shrink-0" @click="folderInput?.click()">
            <FolderOpen :size="14" /> 导入文件夹
          </button>
          <span class="hint !mt-0">选择整个目录，会递归读取其中的 .md / .json</span>
        </div>
        <input
          ref="folderInput"
          type="file"
          accept=".md,.markdown,.json"
          multiple
          webkitdirectory
          class="hidden"
          @change="pickFolder(($event.target as HTMLInputElement).files)"
        />

        <p class="hint">
          导入时按文章 ID 匹配：ID 已存在则覆盖，不存在则新建；批次内重复 ID 会自动加序号。
        </p>
      </section>
    </div>

    <!-- 状态条 -->
    <div v-if="statusText" class="card mb-4 px-4 py-3 flex items-center gap-2 text-[13px] bg-accent-soft border-accent/40">
      <Loader2 :size="15" class="animate-spin text-accent shrink-0" />
      <span class="text-accent truncate">{{ statusText }}</span>
    </div>

    <!-- 搜索 -->
    <div v-if="posts.length > 0" class="relative mb-4">
      <Search :size="16" class="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none" />
      <input v-model="keyword" class="input pl-9" type="search" placeholder="搜索标题或标签…" />
    </div>

    <!-- 选择工具条 -->
    <div v-if="!loading && posts.length > 0" class="flex items-center gap-3 mb-3 flex-wrap">
      <label class="flex items-center gap-2 text-[13px] cursor-pointer select-none">
        <input
          type="checkbox"
          class="accent-[var(--accent)] size-4"
          :checked="allSelected"
          :indeterminate.prop="someSelected"
          @change="toggleAll(($event.target as HTMLInputElement).checked)"
        />
        全选
      </label>
      <span class="text-[13px] text-ink-muted tabular-nums">已选 {{ selected.size }} 篇</span>
      <button class="btn btn-sm btn-primary ml-auto shrink-0" :disabled="!selected.size || busy" @click="exportSelected">
        <PackageOpen :size="14" /> 导出选中
      </button>
    </div>

    <!-- 骨架 -->
    <div v-if="loading" class="space-y-2.5">
      <div v-for="i in 6" :key="i" class="card h-14 shimmer" />
    </div>

    <!-- 空状态 -->
    <div v-else-if="filtered.length === 0" class="card py-16 flex flex-col items-center text-center">
      <span class="grid place-items-center size-12 rounded-2xl bg-surface-2 text-ink-muted mb-3">
        <Inbox :size="22" />
      </span>
      <p class="text-sm font-medium">{{ posts.length === 0 ? '还没有文章' : '没有匹配的文章' }}</p>
      <p class="text-[13px] text-ink-muted mt-1">
        {{ posts.length === 0 ? '写好文章后，这里就能整站导出与迁移。' : '换个关键词试试。' }}
      </p>
    </div>

    <!-- 文章列表 -->
    <div v-else class="card divide-y divide-line overflow-hidden">
      <div v-for="post in filtered" :key="post.id" class="flex items-center gap-3 px-4 py-3">
        <input
          type="checkbox"
          class="accent-[var(--accent)] size-4 shrink-0"
          :checked="selected.has(post.id)"
          @change="toggleSelect(post.id, ($event.target as HTMLInputElement).checked)"
        />

        <span class="grid place-items-center size-9 rounded-lg bg-surface-2 text-ink-muted shrink-0">
          <FileText :size="16" />
        </span>

        <div class="flex-1 min-w-0">
          <p class="text-[13.5px] font-medium truncate">{{ post.title }}</p>
          <p class="text-[12px] text-ink-muted mt-0.5 truncate">
            {{ formatDate(post.date) }}
            <span v-if="post.tags?.length"> · {{ post.tags.join(' / ') }}</span>
          </p>
        </div>

        <span class="badge shrink-0" :class="postStatusMeta[post.status ?? 'published']?.badge">
          {{ postStatusMeta[post.status ?? 'published']?.label ?? '已发布' }}
        </span>

        <button class="btn btn-sm btn-ghost shrink-0" @click="exportOne(post)">
          <FileDown :size="14" />
          <span class="hidden sm:inline">导出 MD</span>
        </button>
      </div>
    </div>
  </div>
</template>
