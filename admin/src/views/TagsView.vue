<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Search, Tag, Pencil, Trash2, Loader2, Inbox } from '@lucide/vue';
import { api, ApiError, type PostSummary } from '../lib/api';
import { toast } from '../lib/toast';

const posts = ref<PostSummary[]>([]);
const loading = ref(true);
const keyword = ref('');
const busy = ref<string | null>(null);

interface TagRow {
  name: string;
  count: number;
}

const rows = computed<TagRow[]>(() => {
  const map = new Map<string, number>();
  for (const post of posts.value) {
    for (const raw of post.tags ?? []) {
      const name = String(raw ?? '').trim();
      if (!name) continue;
      map.set(name, (map.get(name) ?? 0) + 1);
    }
  }
  const q = keyword.value.trim().toLowerCase();
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .filter((row) => !q || row.name.toLowerCase().includes(q))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const data = await api.listPosts({ all: true });
    posts.value = data.posts ?? [];
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '加载标签失败');
  } finally {
    loading.value = false;
  }
}

async function rename(row: TagRow): Promise<void> {
  const next = window.prompt('重命名标签', row.name);
  if (next === null) return;
  const value = next.trim();
  if (!value || value === row.name) return;
  busy.value = row.name;
  try {
    const result = await api.changeTag(row.name, value);
    toast.success(`已重命名，更新了 ${result.updated} 篇文章`);
    await load();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '重命名失败');
  } finally {
    busy.value = null;
  }
}

async function remove(row: TagRow): Promise<void> {
  if (!window.confirm(`删除标签「${row.name}」？该标签会从 ${row.count} 篇文章上移除，文章本身不受影响。`)) return;
  busy.value = row.name;
  try {
    const result = await api.changeTag(row.name, null);
    toast.success(`已删除，更新了 ${result.updated} 篇文章`);
    await load();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '删除失败');
  } finally {
    busy.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center gap-3 mb-5">
      <div class="relative flex-1 min-w-[220px]">
        <Search :size="16" class="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none" />
        <input v-model="keyword" class="input pl-9" type="search" placeholder="搜索标签…" />
      </div>
      <span class="text-[13px] text-ink-muted tabular-nums">{{ rows.length }} 个标签</span>
    </div>

    <div v-if="loading" class="space-y-2.5">
      <div v-for="i in 5" :key="i" class="card h-[58px] shimmer" />
    </div>

    <div v-else-if="rows.length === 0" class="card py-16 flex flex-col items-center text-center">
      <span class="grid place-items-center size-12 rounded-2xl bg-surface-2 text-ink-muted mb-3">
        <Inbox :size="22" />
      </span>
      <p class="text-sm font-medium">{{ posts.length === 0 ? '还没有标签' : '没有符合条件的标签' }}</p>
      <p class="text-[13px] text-ink-muted mt-1">
        {{ posts.length === 0 ? '在文章里添加标签后会自动出现在这里。' : '换个关键词试试。' }}
      </p>
    </div>

    <div v-else class="card divide-y divide-line overflow-hidden">
      <div v-for="row in rows" :key="row.name" class="flex items-center gap-3 px-4 py-3">
        <span class="grid place-items-center size-8 rounded-lg bg-accent-soft text-accent shrink-0">
          <Tag :size="15" />
        </span>
        <span class="badge badge-neutral shrink-0 max-w-[60%] truncate">{{ row.name }}</span>
        <span class="text-[12.5px] text-ink-muted tabular-nums">{{ row.count }} 篇文章</span>
        <div class="ml-auto flex items-center gap-1 shrink-0">
          <button
            class="btn btn-ghost btn-sm"
            :disabled="busy === row.name"
            title="重命名"
            @click="rename(row)"
          >
            <Loader2 v-if="busy === row.name" :size="14" class="animate-spin" />
            <Pencil v-else :size="14" />
            重命名
          </button>
          <button
            class="btn btn-ghost btn-sm hover:text-danger"
            :disabled="busy === row.name"
            title="删除标签"
            @click="remove(row)"
          >
            <Trash2 :size="14" />
          </button>
        </div>
      </div>
    </div>

    <p class="hint mt-4">
      标签由文章自动汇总，重命名或删除会一次性更新所有用到它的文章。
    </p>
  </div>
</template>
