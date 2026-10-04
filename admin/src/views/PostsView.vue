<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Plus, Search, FileText, Pencil, Trash2, ExternalLink, Loader2, Inbox } from '@lucide/vue';
import { api, ApiError, type PostSummary } from '../lib/api';
import { formatDate, postStatusMeta } from '../lib/format';
import { toast } from '../lib/toast';

const router = useRouter();

const posts = ref<PostSummary[]>([]);
const loading = ref(true);
const keyword = ref('');
const status = ref<'all' | 'published' | 'draft' | 'scheduled'>('all');
const deleting = ref<string | null>(null);

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

async function load(): Promise<void> {
  loading.value = true;
  try {
    // all=1：含草稿的摘要列表（需要管理员凭证）
    const data = await api.listPosts({ all: true });
    posts.value = data.posts ?? [];
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
    toast.success('已删除');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '删除失败');
  } finally {
    deleting.value = null;
  }
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
      <article
        v-for="post in filtered"
        :key="post.id"
        class="card group p-4 transition-shadow hover:shadow-md"
      >
        <div class="flex items-start gap-4">
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
    </div>
  </div>
</template>