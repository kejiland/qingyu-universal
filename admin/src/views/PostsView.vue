<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  Plus, Search, FileText, Pencil, Trash2, ExternalLink, Loader2, Inbox,
  Pin, PinOff, List, ChevronLeft, ChevronRight
} from '@lucide/vue';
import { api, ApiError, type PostSummary } from '../lib/api';
import { formatDate, postStatusMeta } from '../lib/format';
import { toast } from '../lib/toast';

const router = useRouter();

const posts = ref<PostSummary[]>([]);
const loading = ref(true);
const keyword = ref('');
const status = ref<'all' | 'published' | 'draft' | 'scheduled'>('all');
const deleting = ref<string | null>(null);
const pinning = ref<string | null>(null);
const busy = ref(false);
const selected = ref<Set<string>>(new Set());

/** 每页条数，与上游 admin.js 服务端分页保持一致（per=10）。 */
const PER_PAGE = 10;
const page = ref(1);

const statusTabs = [
  { key: 'all', label: '全部' },
  { key: 'published', label: '已发布' },
  { key: 'draft', label: '草稿' },
  { key: 'scheduled', label: '定时' }
] as const;

const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase();
  return posts.value.filter((post) => {
    if (status.value !== 'all' && (post.status ?? 'published') !== status.value) return false;
    if (!q) return true;
    const haystack = [post.title, post.excerpt, ...(post.tags ?? [])].join(' ').toLowerCase();
    return haystack.includes(q);
  });
});

const counts = computed(() => {
  const result = { all: posts.value.length, published: 0, draft: 0, scheduled: 0 };
  for (const post of posts.value) {
    const key = (post.status ?? 'published') as 'published' | 'draft' | 'scheduled';
    if (key in result) result[key] += 1;
  }
  return result;
});

const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / PER_PAGE)));
const paged = computed(() => {
  const start = (page.value - 1) * PER_PAGE;
  return filtered.value.slice(start, start + PER_PAGE);
});
const allPageSelected = computed(
  () => paged.value.length > 0 && paged.value.every((post) => selected.value.has(post.id))
);

// 搜索 / 状态筛选变化后回到第一页；总数缩小后收敛页码
watch([keyword, status], () => { page.value = 1; });
watch(totalPages, (n) => { if (page.value > n) page.value = n; });

function toggle(id: string): void {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

function toggleAll(): void {
  const next = new Set(selected.value);
  if (allPageSelected.value) paged.value.forEach((post) => next.delete(post.id));
  else paged.value.forEach((post) => next.add(post.id));
  selected.value = next;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    // all=1：含草稿的摘要列表（需要管理员凭证）
    const data = await api.listPosts({ all: true });
    posts.value = data.posts ?? [];
    selected.value = new Set();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '加载文章失败');
  } finally {
    loading.value = false;
  }
}

async function remove(post: PostSummary): Promise<void> {
  if (!window.confirm(`确定删除《${post.title}》？该文章的评论与统计会一并删除。`)) return;
  deleting.value = post.id;
  try {
    await api.deletePost(post.id);
    posts.value = posts.value.filter((item) => item.id !== post.id);
    const next = new Set(selected.value);
    next.delete(post.id);
    selected.value = next;
    toast.success('已删除');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '删除失败');
  } finally {
    deleting.value = null;
  }
}

/**
 * 行内置顶切换。上游 PUT /api/posts/:id 是整篇覆写，
 * 因此必须先取回完整文章再改 pinned，避免其余字段被清空。
 */
async function togglePin(post: PostSummary): Promise<void> {
  const next = !post.pinned;
  pinning.value = post.id;
  try {
    const { post: detail } = await api.getPost(post.id);
    await api.updatePost(post.id, { ...detail, pinned: next });
    post.pinned = next;
    toast.success(next ? '已置顶' : '已取消置顶');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '操作失败');
  } finally {
    pinning.value = null;
  }
}

/** 批量置顶 / 取消置顶：逐条取回完整文章后 PUT，统计成功条数。 */
async function bulkPin(pinned: boolean): Promise<void> {
  const ids = [...selected.value];
  if (!ids.length) return;
  busy.value = true;
  let ok = 0;
  for (const id of ids) {
    try {
      const { post: detail } = await api.getPost(id);
      await api.updatePost(id, { ...detail, pinned });
      const item = posts.value.find((post) => post.id === id);
      if (item) item.pinned = pinned;
      ok += 1;
    } catch {
      /* 单条失败不阻断，最后按成功条数提示 */
    }
  }
  busy.value = false;
  selected.value = new Set();
  if (ok) toast.success(pinned ? `已置顶 ${ok} 篇` : `已取消置顶 ${ok} 篇`);
  else toast.error('批量操作失败');
}

/** 批量删除：逐条 DELETE，统计成功条数。 */
async function bulkDelete(): Promise<void> {
  const ids = [...selected.value];
  if (!ids.length) return;
  if (!window.confirm(`确定删除选中的 ${ids.length} 篇文章？相关评论与统计会一并删除。`)) return;
  busy.value = true;
  let ok = 0;
  for (const id of ids) {
    try {
      await api.deletePost(id);
      ok += 1;
    } catch {
      /* 单条失败不阻断，最后按成功条数提示 */
    }
  }
  posts.value = posts.value.filter((post) => !selected.value.has(post.id));
  busy.value = false;
  selected.value = new Set();
  if (ok) toast.success(`已删除 ${ok} 篇`);
  else toast.error('删除失败');
}

onMounted(load);
</script>

<template>
  <div>
    <!-- 工具条 -->
    <div class="flex flex-wrap items-center gap-3 mb-5">
      <div class="relative flex-1 min-w-[220px]">
        <Search :size="16" class="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none" />
        <input v-model="keyword" class="input pl-9" type="search" placeholder="搜索标题、摘要或标签…" />
      </div>

      <div class="flex gap-1 p-1 rounded-xl bg-surface-2">
        <button
          v-for="tab in statusTabs"
          :key="tab.key"
          class="h-7 px-3 rounded-[8px] text-[13px] font-medium transition-all whitespace-nowrap"
          :class="status === tab.key ? 'bg-surface text-ink shadow-xs' : 'text-ink-muted hover:text-ink'"
          @click="status = tab.key"
        >
          {{ tab.label }}
          <span class="ml-1 text-ink-muted tabular-nums">{{ counts[tab.key] }}</span>
        </button>
      </div>

      <button class="btn btn-primary" @click="router.push({ name: 'post-new' })">
        <Plus :size="16" />
        新建文章
      </button>
    </div>

    <!-- 批量操作条 -->
    <Transition name="fade">
      <div
        v-if="selected.size > 0"
        class="sticky top-16 z-10 mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-accent/30 bg-accent-soft px-3 py-2"
      >
        <span class="text-[13px] text-accent font-medium">已选 {{ selected.size }} 篇</span>
        <div class="ml-auto flex flex-wrap gap-2">
          <button class="btn btn-sm btn-secondary" :disabled="busy" @click="bulkPin(true)">
            <Pin :size="14" /> 置顶
          </button>
          <button class="btn btn-sm btn-secondary" :disabled="busy" @click="bulkPin(false)">
            <PinOff :size="14" /> 取消置顶
          </button>
          <button class="btn btn-sm btn-danger" :disabled="busy" @click="bulkDelete">
            <Loader2 v-if="busy" :size="14" class="animate-spin" />
            <Trash2 v-else :size="14" /> 删除
          </button>
        </div>
      </div>
    </Transition>

    <!-- 加载骨架 -->
    <div v-if="loading" class="space-y-2.5">
      <div v-for="i in 4" :key="i" class="card p-4 h-[86px] shimmer" />
    </div>

    <!-- 空状态 -->
    <div v-else-if="filtered.length === 0" class="card py-16 flex flex-col items-center text-center">
      <span class="grid place-items-center size-12 rounded-2xl bg-surface-2 text-ink-muted mb-3">
        <Inbox :size="22" />
      </span>
      <p class="text-sm font-medium">
        {{ posts.length === 0 ? '还没有文章' : '没有符合条件的文章' }}
      </p>
      <p class="text-[13px] text-ink-muted mt-1">
        {{ posts.length === 0 ? '写下第一篇，开始记录。' : '试试换个关键词或状态筛选。' }}
      </p>
      <button v-if="posts.length === 0" class="btn btn-primary mt-5" @click="router.push({ name: 'post-new' })">
        <Plus :size="16" />
        新建文章
      </button>
    </div>

    <!-- 列表 -->
    <div v-else class="space-y-2.5">
      <!-- 全选当前页 -->
      <label class="flex items-center gap-2 px-1 text-[12.5px] text-ink-muted cursor-pointer select-none">
        <input
          type="checkbox"
          class="accent-[var(--accent)] size-4"
          :checked="allPageSelected"
          @change="toggleAll"
        />
        全选本页
      </label>

      <article
        v-for="post in paged"
        :key="post.id"
        class="card group p-4 transition-shadow hover:shadow-md"
        :class="selected.has(post.id) ? 'border-accent/40' : ''"
      >
        <div class="flex items-start gap-3.5">
          <!-- 选择框 -->
          <input
            type="checkbox"
            class="mt-1 accent-[var(--accent)] size-4 shrink-0"
            :checked="selected.has(post.id)"
            @change="toggle(post.id)"
          />

          <!-- 封面缩略图 -->
          <div
            v-if="post.cover"
            class="hidden sm:block size-14 shrink-0 rounded-xl overflow-hidden border border-line bg-surface-2"
          >
            <img :src="post.cover" alt="" class="size-full object-cover" loading="lazy" />
          </div>
          <div
            v-else
            class="hidden sm:grid place-items-center size-14 shrink-0 rounded-xl border border-line bg-surface-2 text-ink-muted"
          >
            <FileText :size="19" />
          </div>

          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <h3 class="text-[15px] font-semibold truncate">{{ post.title || '未命名' }}</h3>
              <span
                class="badge"
                :class="postStatusMeta[post.status]?.badge ?? 'badge-neutral'"
              >
                {{ postStatusMeta[post.status]?.label ?? post.status }}
              </span>
              <!-- 系列标记 -->
              <span v-if="post.series" class="badge badge-neutral inline-flex items-center gap-1">
                <List :size="11" />
                {{ post.series }}<template v-if="post.seriesOrder"> #{{ post.seriesOrder }}</template>
              </span>
              <span v-if="post.pinned" class="badge badge-info">置顶</span>
              <span v-if="post.protected" class="badge badge-warning">加密</span>
            </div>

            <p v-if="post.excerpt" class="text-[13px] text-ink-muted mt-1 line-clamp-1">{{ post.excerpt }}</p>

            <div class="flex items-center gap-3 mt-2 text-[12px] text-ink-muted">
              <span>{{ formatDate(post.date) }}</span>
              <span v-if="post.category" class="truncate">· {{ post.category }}</span>
              <span v-if="post.tags?.length" class="truncate">· {{ post.tags.slice(0, 3).join(' / ') }}</span>
            </div>
          </div>

          <!-- 操作 -->
          <div class="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <button
              class="btn btn-ghost btn-icon btn-sm"
              :title="post.pinned ? '取消置顶' : '置顶'"
              :disabled="pinning === post.id"
              @click="togglePin(post)"
            >
              <Loader2 v-if="pinning === post.id" :size="16" class="animate-spin" />
              <PinOff v-else-if="post.pinned" :size="16" />
              <Pin v-else :size="16" />
            </button>
            <button class="btn btn-ghost btn-icon btn-sm" title="编辑" @click="router.push({ name: 'post-edit', params: { id: post.id } })">
              <Pencil :size="16" />
            </button>
            <a
              v-if="post.status === 'published'"
              class="btn btn-ghost btn-icon btn-sm"
              :href="`/posts/${encodeURIComponent(post.id)}/`"
              target="_blank"
              rel="noopener"
              title="查看"
            >
              <ExternalLink :size="16" />
            </a>
            <button
              class="btn btn-ghost btn-icon btn-sm hover:text-danger"
              title="删除"
              :disabled="deleting === post.id"
              @click="remove(post)"
            >
              <Loader2 v-if="deleting === post.id" :size="16" class="animate-spin" />
              <Trash2 v-else :size="16" />
            </button>
          </div>
        </div>
      </article>

      <!-- 分页 -->
      <div v-if="totalPages > 1" class="flex items-center justify-between px-1 pt-1">
        <span class="text-[12.5px] text-ink-muted">
          第 {{ page }} / {{ totalPages }} 页 · 共 {{ filtered.length }} 篇
        </span>
        <div class="flex items-center gap-1.5">
          <button class="btn btn-sm btn-ghost btn-icon" :disabled="page <= 1" title="上一页" @click="page -= 1">
            <ChevronLeft :size="16" />
          </button>
          <button class="btn btn-sm btn-ghost btn-icon" :disabled="page >= totalPages" title="下一页" @click="page += 1">
            <ChevronRight :size="16" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
