<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { PenLine, Layers, Pencil, Trash2, Loader2, Inbox } from '@lucide/vue';
import { api, ApiError, type PostSummary } from '../lib/api';
import { toast } from '../lib/toast';

const router = useRouter();
const posts = ref<PostSummary[]>([]);
const loading = ref(true);
const busy = ref<string | null>(null);

interface SeriesRow {
  name: string;
  posts: PostSummary[];
  orders: number[];
}

const rows = computed<SeriesRow[]>(() => {
  const map = new Map<string, PostSummary[]>();
  for (const post of posts.value) {
    const name = String(post.series ?? '').trim();
    if (!name) continue;
    const list = map.get(name) ?? [];
    list.push(post);
    map.set(name, list);
  }
  return [...map.entries()]
    .map(([name, list]) => ({
      name,
      posts: list,
      orders: list
        .map((post) => Number(post.seriesOrder ?? 0) || 0)
        .slice()
        .sort((a, b) => a - b)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const data = await api.listPosts({ all: true });
    posts.value = data.posts ?? [];
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '加载系列失败');
  } finally {
    loading.value = false;
  }
}

/** 逐篇读取完整文章再回写，避免摘要字段把正文清空。 */
async function updateSeries(row: SeriesRow, next: string): Promise<void> {
  busy.value = row.name;
  let done = 0;
  try {
    for (const summary of row.posts) {
      const detail = await api.getPost(summary.id);
      await api.updatePost(summary.id, { ...detail.post, series: next });
      done += 1;
    }
    toast.success(`已更新 ${done} 篇文章`);
    await load();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '更新失败');
  } finally {
    busy.value = null;
  }
}

function rename(row: SeriesRow): void {
  const next = window.prompt('重命名系列', row.name);
  if (next === null) return;
  const value = next.trim();
  if (!value || value === row.name) return;
  void updateSeries(row, value);
}

function remove(row: SeriesRow): void {
  if (!window.confirm(`删除系列「${row.name}」？${row.posts.length} 篇文章会移出该系列，文章本身保留。`)) return;
  void updateSeries(row, '');
}

onMounted(load);
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center gap-3 mb-5">
      <p class="text-[13px] text-ink-muted">
        系列是文章的专栏分组，同一系列内的文章按序号排列。
      </p>
      <button class="btn btn-primary ml-auto" @click="router.push({ name: 'post-new' })">
        <PenLine :size="16" />
        写新文章
      </button>
    </div>

    <div v-if="loading" class="space-y-2.5">
      <div v-for="i in 4" :key="i" class="card h-[72px] shimmer" />
    </div>

    <div v-else-if="rows.length === 0" class="card py-16 flex flex-col items-center text-center">
      <span class="grid place-items-center size-12 rounded-2xl bg-surface-2 text-ink-muted mb-3">
        <Inbox :size="22" />
      </span>
      <p class="text-sm font-medium">还没有系列</p>
      <p class="text-[13px] text-ink-muted mt-1">在文章编辑页填写「系列」后，会自动汇总到这里。</p>
      <button class="btn btn-primary mt-5" @click="router.push({ name: 'post-new' })">
        <PenLine :size="16" />
        写新文章
      </button>
    </div>

    <div v-else class="space-y-2.5">
      <article v-for="row in rows" :key="row.name" class="card p-4">
        <div class="flex items-center gap-3">
          <span class="grid place-items-center size-9 rounded-xl bg-accent-soft text-accent shrink-0">
            <Layers :size="17" />
          </span>

          <div class="flex-1 min-w-0">
            <p class="text-[14px] font-semibold truncate">{{ row.name }}</p>
            <p class="text-[12px] text-ink-muted mt-0.5">
              {{ row.posts.length }} 篇文章 · 序号 {{ row.orders.join(', ') }}
            </p>
          </div>

          <div class="flex items-center gap-1 shrink-0">
            <button
              class="btn btn-ghost btn-sm"
              :disabled="busy === row.name"
              @click="rename(row)"
            >
              <Loader2 v-if="busy === row.name" :size="14" class="animate-spin" />
              <Pencil v-else :size="14" />
              重命名
            </button>
            <button
              class="btn btn-ghost btn-sm hover:text-danger"
              :disabled="busy === row.name"
              title="删除系列"
              @click="remove(row)"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </div>

        <div class="flex flex-wrap gap-1.5 mt-3 pl-12">
          <span
            v-for="post in row.posts.slice(0, 8)"
            :key="post.id"
            class="badge badge-neutral max-w-[220px] truncate"
          >
            {{ post.title }}
          </span>
          <span v-if="row.posts.length > 8" class="text-[12px] text-ink-muted self-center">
            等 {{ row.posts.length }} 篇
          </span>
        </div>
      </article>
    </div>
  </div>
</template>
