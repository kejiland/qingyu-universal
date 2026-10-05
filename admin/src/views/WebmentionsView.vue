<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Loader2, Trash2, Inbox } from '@lucide/vue';
import { api, ApiError, type components } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { toast } from '../lib/toast';

type Mention = components['schemas']['WebmentionItem'];

const items = ref<Mention[]>([]);
const loading = ref(true);
const busyId = ref<number | null>(null);

const byStatus = computed(() => {
  const map: Record<string, Mention[]> = { approved: [], pending: [], spam: [] };
  for (const m of items.value) (map[m.status] ??= []).push(m);
  return map;
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const data = await api.listWebmentions();
    items.value = data.mentions ?? [];
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

async function remove(m: Mention): Promise<void> {
  if (!window.confirm(`删除来自 ${m.source} 的提及？`)) return;
  busyId.value = m.id;
  try {
    await api.deleteWebmention(m.id);
    items.value = items.value.filter((x) => x.id !== m.id);
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
    <div class="flex items-center gap-3 mb-5">
      <p class="text-[13px] text-ink-muted flex-1">
        站外文章链接到你的博客时会发送 Webmention，作者回复可在这里查看与管理。
      </p>
    </div>

    <div class="grid grid-cols-3 gap-3 mb-5">
      <div class="card p-4">
        <div class="text-[22px] font-semibold tabular-nums">{{ byStatus.approved?.length ?? 0 }}</div>
        <div class="text-[12.5px] text-ink-muted mt-0.5">已通过</div>
      </div>
      <div class="card p-4">
        <div class="text-[22px] font-semibold tabular-nums">{{ byStatus.pending?.length ?? 0 }}</div>
        <div class="text-[12.5px] text-ink-muted mt-0.5">待审核</div>
      </div>
      <div class="card p-4">
        <div class="text-[22px] font-semibold tabular-nums">{{ byStatus.spam?.length ?? 0 }}</div>
        <div class="text-[12.5px] text-ink-muted mt-0.5">垃圾</div>
      </div>
    </div>

    <div v-if="loading" class="card h-40 shimmer" />
    <div v-else-if="items.length === 0" class="card py-16 flex flex-col items-center text-center">
      <span class="grid place-items-center size-12 rounded-2xl bg-surface-2 text-ink-muted mb-3"><Inbox :size="22" /></span>
      <p class="text-sm font-medium">还没有 Webmention</p>
      <p class="text-[13px] text-ink-muted mt-1">别的站点链接到你的文章时会出现在这里。</p>
    </div>

    <div v-else class="space-y-2.5">
      <article v-for="m in items" :key="m.id" class="card p-4 flex gap-3.5">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-[14px] font-semibold">{{ m.author_name || '匿名' }}</span>
            <span class="badge" :class="m.status === 'pending' ? 'badge-warning' : m.status === 'spam' ? 'badge-danger' : 'badge-success'">
              {{ m.status === 'approved' ? '已通过' : m.status === 'pending' ? '待审核' : '垃圾' }}
            </span>
            <span class="text-[12px] text-ink-muted ml-auto">{{ formatDateTime(m.created_at) }}</span>
          </div>
          <p v-if="m.title" class="text-[13.5px] mt-2">{{ m.title }}</p>
          <p v-if="m.excerpt" class="text-[13px] text-ink-soft mt-1 line-clamp-2">{{ m.excerpt }}</p>
          <a :href="m.source" target="_blank" rel="noopener nofollow" class="text-[12px] text-accent hover:underline mt-2 inline-block truncate max-w-full">
            {{ m.source }}
          </a>
        </div>
        <button class="btn btn-ghost btn-sm hover:text-danger shrink-0" :disabled="busyId === m.id" @click="remove(m)">
          <Loader2 v-if="busyId === m.id" :size="14" class="animate-spin" /><Trash2 v-else :size="14" />
        </button>
      </article>
    </div>
  </div>
</template>