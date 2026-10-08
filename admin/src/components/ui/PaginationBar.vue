<script setup lang="ts">
/* 共享分页条：与 MusicView 的视觉 / 交互一致，日志、订阅者、备份页复用。 */
import { computed } from 'vue';
import { ChevronLeft, ChevronRight } from '@lucide/vue';

const page = defineModel<number>('page', { required: true });
const props = defineProps<{
  /** 过滤后的总条数 */
  total: number;
  /** 每页条数 */
  per: number;
  /** 计数单位，默认「条」 */
  unit?: string;
}>();

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.per)));
const current = computed(() => Math.min(Math.max(1, page.value), totalPages.value));

function go(delta: number): void {
  const next = current.value + delta;
  if (next >= 1 && next <= totalPages.value) page.value = next;
}
</script>

<template>
  <div v-if="totalPages > 1" class="flex items-center justify-between px-4 py-3">
    <span class="text-[12.5px] text-ink-muted tabular-nums">
      第 {{ current }} / {{ totalPages }} 页 · 共 {{ total }} {{ unit ?? '条' }}
    </span>
    <div class="flex items-center gap-1.5">
      <button class="btn btn-sm btn-ghost btn-icon" :disabled="current <= 1" title="上一页" @click="go(-1)">
        <ChevronLeft :size="16" />
      </button>
      <button class="btn btn-sm btn-ghost btn-icon" :disabled="current >= totalPages" title="下一页" @click="go(1)">
        <ChevronRight :size="16" />
      </button>
    </div>
  </div>
</template>
