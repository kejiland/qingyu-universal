<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ScrollText, Bug, Inbox, RefreshCw, Loader2 } from '@lucide/vue';
import { api, ApiError, type AuditLogItem, type ErrorLogItem } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { toast } from '../lib/toast';

type Tab = 'audit' | 'errors';

const tab = ref<Tab>('audit');
const audit = ref<AuditLogItem[]>([]);
const counts = ref<Record<string, number>>({});
const errors = ref<ErrorLogItem[]>([]);
const errorTotal = ref(0);
const errorHits = ref(0);
const loading = ref(true);
const refreshing = ref(false);
const expanded = ref<Set<number>>(new Set());

const actionLabel: Record<string, string> = {
  'post.delete': '删除文章',
  'settings.update': '更新设置',
  'comment.bulk': '批量评论',
  'auth.login': '登录',
  'auth.logout': '退出',
  'backup.create': '创建备份',
  'backup.restore': '恢复备份'
};

const topActions = computed(() =>
  Object.entries(counts.value)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
);

async function load(showSpinner = true): Promise<void> {
  if (showSpinner) loading.value = true;
  else refreshing.value = true;
  try {
    const [a, e] = await Promise.all([api.listAudit(200), api.listErrors()]);
    audit.value = a.logs ?? [];
    counts.value = a.counts ?? {};
    errors.value = e.errors ?? [];
    errorTotal.value = e.total ?? 0;
    errorHits.value = e.sumHits ?? 0;
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '加载日志失败');
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

function toggleError(id: number): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

onMounted(() => load());
</script>

<template>
  <div>
    <div class="flex items-center gap-3 mb-5 flex-wrap">
      <div class="flex gap-1 p-1 rounded-xl bg-surface-2">
        <button
          class="h-7 px-3 rounded-[8px] text-[13px] font-medium transition-all inline-flex items-center gap-1.5"
          :class="tab === 'audit' ? 'bg-surface text-ink shadow-xs' : 'text-ink-muted hover:text-ink'"
          @click="tab = 'audit'"
        >
          <ScrollText :size="14" /> 操作审计
          <span class="tabular-nums text-ink-muted">{{ audit.length }}</span>
        </button>
        <button
          class="h-7 px-3 rounded-[8px] text-[13px] font-medium transition-all inline-flex items-center gap-1.5"
          :class="tab === 'errors' ? 'bg-surface text-ink shadow-xs' : 'text-ink-muted hover:text-ink'"
          @click="tab = 'errors'"
        >
          <Bug :size="14" /> 错误日志
          <span class="tabular-nums" :class="errorTotal > 0 ? 'text-danger' : 'text-ink-muted'">{{ errorTotal }}</span>
        </button>
      </div>

      <button class="btn btn-ghost btn-sm ml-auto" :disabled="refreshing" @click="load(false)">
        <Loader2 v-if="refreshing" :size="14" class="animate-spin" />
        <RefreshCw v-else :size="14" />
        刷新
      </button>
    </div>

    <div v-if="loading" class="space-y-2.5">
      <div v-for="i in 5" :key="i" class="card h-[62px] shimmer" />
    </div>

    <template v-else>
      <!-- 操作审计 -->
      <div v-if="tab === 'audit'">
        <div v-if="topActions.length" class="flex flex-wrap gap-2 mb-4">
          <span
            v-for="[action, n] in topActions"
            :key="action"
            class="badge badge-neutral"
          >
            {{ actionLabel[action] ?? action }} <span class="tabular-nums opacity-70">{{ n }}</span>
          </span>
        </div>

        <div v-if="audit.length === 0" class="card py-16 flex flex-col items-center text-center">
          <span class="grid place-items-center size-12 rounded-2xl bg-surface-2 text-ink-muted mb-3">
            <Inbox :size="22" />
          </span>
          <p class="text-sm font-medium">还没有操作记录</p>
        </div>

        <div v-else class="card divide-y divide-line overflow-hidden">
          <div v-for="log in audit" :key="log.id" class="flex items-center gap-3 px-4 py-3">
            <span class="badge badge-neutral shrink-0">{{ actionLabel[log.action] ?? log.action }}</span>
            <span class="text-[13px] truncate flex-1" :title="log.detail">{{ log.target || log.detail || '—' }}</span>
            <span class="text-[12px] text-ink-muted font-mono shrink-0 hidden sm:inline">{{ log.ip || '—' }}</span>
            <span class="text-[12px] text-ink-muted shrink-0">{{ formatDateTime(log.created_at) }}</span>
          </div>
        </div>
      </div>

      <!-- 错误日志 -->
      <div v-else>
        <p v-if="errorHits > 0" class="text-[13px] text-ink-muted mb-4">
          共 <strong class="text-danger">{{ errorTotal }}</strong> 类错误，累计触发
          <strong class="text-danger">{{ errorHits }}</strong> 次（按指纹聚合）。
        </p>

        <div v-if="errors.length === 0" class="card py-16 flex flex-col items-center text-center">
          <span class="grid place-items-center size-12 rounded-2xl bg-success-soft text-success mb-3">
            <Inbox :size="22" />
          </span>
          <p class="text-sm font-medium">没有错误记录</p>
          <p class="text-[13px] text-ink-muted mt-1">前端上报的异常会聚合到这里。</p>
        </div>

        <div v-else class="space-y-2.5">
          <article v-for="item in errors" :key="item.id" class="card p-4">
            <button class="w-full text-left" @click="toggleError(item.id)">
              <div class="flex items-start gap-3">
                <span class="badge shrink-0" :class="item.kind === 'error' ? 'badge-danger' : 'badge-warning'">
                  {{ item.kind }}
                </span>
                <div class="flex-1 min-w-0">
                  <p class="text-[13.5px] font-medium break-words">{{ item.message }}</p>
                  <p class="text-[12px] text-ink-muted mt-1">
                    {{ item.source || '未知来源' }} · 触发 {{ item.hits }} 次 · {{ formatDateTime(item.last_at ?? item.created_at) }}
                  </p>
                </div>
              </div>
            </button>

            <Transition name="fade">
              <pre
                v-if="expanded.has(item.id)"
                class="mt-3 text-[11.5px] leading-relaxed bg-surface-2 border border-line rounded-lg p-3 overflow-x-auto text-ink-soft"
              >{{ item.stack || item.url || '(无堆栈信息)' }}</pre>
            </Transition>
          </article>
        </div>
      </div>
    </template>
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