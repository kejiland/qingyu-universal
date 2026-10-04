<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { DatabaseBackup, Loader2, Trash2, RotateCcw, AlertTriangle, Inbox } from '@lucide/vue';
import { api, ApiError, type BackupItem } from '../lib/api';
import { formatBytes, formatDateTime } from '../lib/format';
import { toast } from '../lib/toast';

const items = ref<BackupItem[]>([]);
const configured = ref(true);
const loading = ref(true);
const creating = ref(false);
const busyId = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const data = await api.listBackups();
    items.value = data.backups ?? [];
    configured.value = data.configured;
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '加载备份失败');
  } finally {
    loading.value = false;
  }
}

async function create(): Promise<void> {
  creating.value = true;
  try {
    await api.createBackup();
    toast.success('备份已创建');
    await load();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '创建失败');
  } finally {
    creating.value = false;
  }
}

async function remove(item: BackupItem): Promise<void> {
  if (!window.confirm('删除这份备份？该操作不可撤销。')) return;
  busyId.value = item.id;
  try {
    await api.deleteBackup(item.id);
    items.value = items.value.filter((b) => b.id !== item.id);
    toast.success('已删除');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '删除失败');
  } finally {
    busyId.value = null;
  }
}

async function restore(item: BackupItem): Promise<void> {
  const ok = window.confirm(
    `确定从这份备份恢复？\n\n${formatDateTime(item.createdAt)}\n\n` +
      '当前数据会被备份内容覆盖，此操作不可撤销。建议先创建一份新备份。'
  );
  if (!ok) return;
  busyId.value = item.id;
  try {
    await api.restoreBackup(item.id);
    toast.success('恢复完成');
    await load();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '恢复失败');
  } finally {
    busyId.value = null;
  }
}

function countSummary(counts: Record<string, number>): string {
  const entries = Object.entries(counts || {}).filter(([, n]) => n > 0);
  if (!entries.length) return '—';
  return entries.map(([table, n]) => `${table} ${n}`).join(' · ');
}

onMounted(load);
</script>

<template>
  <div>
    <div v-if="!configured && !loading" class="card mb-5 p-4 border-warning/40 bg-warning-soft flex gap-3">
      <AlertTriangle :size="18" class="text-warning shrink-0 mt-0.5" />
      <div class="text-[13px] leading-relaxed">
        <p class="font-medium text-warning">未配置备份存储桶</p>
        <p class="text-ink-soft mt-1">
          当前只能查看历史记录。在 <code>.env</code> 中设置 <code>S3_BACKUP_BUCKET</code>（或
          <code>R2_BACKUP_BUCKET</code>）并重启后即可创建新备份。本地磁盘模式下该桶指向
          <code>data/uploads/backups</code>。
        </p>
      </div>
    </div>

    <div class="flex items-center gap-3 mb-5">
      <p class="text-[13px] text-ink-muted">
        最多保留 30 份，超出后自动清理最旧的。每天 19:00 UTC 会创建一次自动备份。
      </p>
      <button class="btn btn-primary ml-auto shrink-0" :disabled="creating || !configured" @click="create">
        <Loader2 v-if="creating" :size="16" class="animate-spin" />
        <DatabaseBackup v-else :size="16" />
        <span>{{ creating ? '备份中…' : '立即备份' }}</span>
      </button>
    </div>

    <div v-if="loading" class="space-y-2.5">
      <div v-for="i in 3" :key="i" class="card h-[76px] shimmer" />
    </div>

    <div v-else-if="items.length === 0" class="card py-16 flex flex-col items-center text-center">
      <span class="grid place-items-center size-12 rounded-2xl bg-surface-2 text-ink-muted mb-3">
        <Inbox :size="22" />
      </span>
      <p class="text-sm font-medium">还没有备份</p>
      <p class="text-[13px] text-ink-muted mt-1">点右上角「立即备份」创建第一份快照。</p>
    </div>

    <div v-else class="space-y-2.5">
      <article v-for="item in items" :key="item.id" class="card p-4">
        <div class="flex items-start gap-4">
          <span class="grid place-items-center size-10 rounded-xl bg-surface-2 text-ink-soft shrink-0">
            <DatabaseBackup :size="18" />
          </span>

          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-[14px] font-semibold">{{ formatDateTime(item.createdAt) }}</span>
              <span class="badge" :class="item.reason === 'auto' ? 'badge-neutral' : 'badge-info'">
                {{ item.reason === 'auto' ? '自动' : '手动' }}
              </span>
              <span class="text-[12px] text-ink-muted">{{ formatBytes(item.size) }}</span>
            </div>
            <p class="text-[12px] text-ink-muted mt-1.5 truncate" :title="countSummary(item.counts)">
              {{ countSummary(item.counts) }}
            </p>
          </div>

          <div class="flex items-center gap-1 shrink-0">
            <button class="btn btn-sm btn-secondary" :disabled="busyId === item.id" @click="restore(item)">
              <Loader2 v-if="busyId === item.id" :size="14" class="animate-spin" />
              <RotateCcw v-else :size="14" />
              <span class="hidden sm:inline">恢复</span>
            </button>
            <button class="btn btn-sm btn-ghost hover:text-danger" :disabled="busyId === item.id" @click="remove(item)">
              <Trash2 :size="14" />
            </button>
          </div>
        </div>
      </article>
    </div>
  </div>
</template>