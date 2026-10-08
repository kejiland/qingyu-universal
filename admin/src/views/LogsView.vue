<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ScrollText, Bug, Gauge, Inbox, RefreshCw, Loader2, Download, Trash2 } from '@lucide/vue';
import { api, ApiError, type AuditLogItem, type ErrorLogItem } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { downloadCsv, stamp } from '../lib/transfer';
import { toast } from '../lib/toast';
import PaginationBar from '../components/ui/PaginationBar.vue';

type Tab = 'audit' | 'errors';

/** 与上游 pageAudit 的 AUDIT_ACTIONS 保持一致。 */
const AUDIT_ACTIONS = [
  'post.delete',
  'media.delete',
  'settings.update',
  'backup.create',
  'backup.restore',
  'backup.delete',
  'audit.clear'
] as const;

const PER_AUDIT = 20;

const route = useRoute();

/* 页签跟路由走：侧栏「操作日志」/「错误日志」是两个独立入口，共用本页。
 * 两个路由用的是同一个组件，Vue Router 可能复用实例，所以除了初值还要 watch。 */
const tab = ref<Tab>(route.meta.tab === 'errors' ? 'errors' : 'audit');
watch(
  () => route.meta.tab,
  (value) => {
    tab.value = value === 'errors' ? 'errors' : 'audit';
  }
);
const audit = ref<AuditLogItem[]>([]);
const counts = ref<Record<string, number>>({});
const errors = ref<ErrorLogItem[]>([]);
const errorTotal = ref(0);
const errorHits = ref(0);
const loading = ref(true);
const refreshing = ref(false);
const expanded = ref<Set<number>>(new Set());

/* 审计筛选状态 */
const auditAction = ref<string>('all');
const auditFrom = ref('');
const auditTo = ref('');
const auditPage = ref(1);
/* 错误关键词 */
const errorKeyword = ref('');

const actionLabel: Record<string, string> = {
  'post.delete': '删除文章',
  'media.delete': '删除媒体',
  'settings.update': '更新设置',
  'comment.bulk': '批量评论',
  'auth.login': '登录',
  'auth.logout': '退出',
  'backup.create': '创建备份',
  'backup.restore': '恢复备份',
  'backup.delete': '删除备份',
  'audit.clear': '清空审计'
};

const topActions = computed(() =>
  Object.entries(counts.value)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
);

/** 操作类型走后端过滤（GET ?action=），日期范围在前端按当天 00:00 / 23:59:59 过滤。 */
const auditFiltered = computed(() => {
  let list = audit.value;
  if (auditFrom.value) {
    const from = new Date(`${auditFrom.value}T00:00:00`).getTime();
    if (!Number.isNaN(from)) list = list.filter((r) => Number(r.created_at) >= from);
  }
  if (auditTo.value) {
    const to = new Date(`${auditTo.value}T23:59:59`).getTime();
    if (!Number.isNaN(to)) list = list.filter((r) => Number(r.created_at) <= to);
  }
  return list;
});

const auditPageItems = computed(() => {
  const current = Math.min(auditPage.value, Math.max(1, Math.ceil(auditFiltered.value.length / PER_AUDIT)));
  return auditFiltered.value.slice((current - 1) * PER_AUDIT, current * PER_AUDIT);
});

/** 前端搜索 message / source / url。 */
const errorsFiltered = computed(() => {
  const q = errorKeyword.value.trim().toLowerCase();
  if (!q) return errors.value;
  return errors.value.filter((x) =>
    `${x.message} ${x.source ?? ''} ${x.url ?? ''}`.toLowerCase().includes(q)
  );
});

function auditQuery(): { limit: number; action?: string } {
  return { limit: 500, action: auditAction.value === 'all' ? undefined : auditAction.value };
}

async function load(showSpinner = true): Promise<void> {
  if (showSpinner) loading.value = true;
  else refreshing.value = true;
  try {
    const [a, e] = await Promise.all([api.listAudit(auditQuery()), api.listErrors()]);
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

/** 操作类型切换：重新拉取（服务端过滤）并回到第一页。 */
function onAuditActionChange(): void {
  auditPage.value = 1;
  void load(false);
}

function resetAudit(): void {
  auditAction.value = 'all';
  auditFrom.value = '';
  auditTo.value = '';
  auditPage.value = 1;
  void load(false);
}

/** 导出当前筛选结果为 CSV（列：time, action, target, detail, ip）。 */
function exportAuditCsv(): void {
  const rows: Array<Array<string | number>> = [['time', 'action', 'target', 'detail', 'ip']];
  auditFiltered.value.forEach((r) => {
    rows.push([
      r.created_at ? new Date(Number(r.created_at)).toISOString() : '',
      r.action || '',
      r.target || '',
      r.detail || '',
      r.ip || ''
    ]);
  });
  downloadCsv(`audit-${stamp()}.csv`, rows);
  toast.success(`已导出 ${auditFiltered.value.length} 条`);
}

async function clearAudit(): Promise<void> {
  if (!window.confirm('确定清空全部操作日志？该操作不可撤销。')) return;
  try {
    await api.clearAudit();
    audit.value = [];
    counts.value = {};
    auditPage.value = 1;
    toast.success('操作日志已清空');
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '清空失败');
  }
}

async function clearErrors(): Promise<void> {
  if (!window.confirm('确定清空全部错误日志？该操作不可撤销。')) return;
  try {
    await api.clearErrors();
    errors.value = [];
    errorTotal.value = 0;
    errorHits.value = 0;
    expanded.value = new Set();
    toast.success('错误日志已清空');
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '清空失败');
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
        <!-- 工具栏：操作类型 / 日期范围 / 重置 / 总数 / 导出 / 清空 -->
        <div class="flex flex-wrap items-center gap-2 mb-4">
          <select v-model="auditAction" class="select !w-auto" @change="onAuditActionChange">
            <option value="all">全部类型</option>
            <option v-for="a in AUDIT_ACTIONS" :key="a" :value="a">{{ actionLabel[a] ?? a }}</option>
          </select>
          <input v-model="auditFrom" class="input !w-[150px]" type="date" aria-label="起始日期" @change="auditPage = 1" />
          <span class="text-[13px] text-ink-muted">—</span>
          <input v-model="auditTo" class="input !w-[150px]" type="date" aria-label="结束日期" @change="auditPage = 1" />
          <button class="btn btn-ghost btn-sm" @click="resetAudit">重置</button>
          <span class="text-[13px] text-ink-muted ml-auto tabular-nums">共 {{ auditFiltered.length }} 条</span>
          <button class="btn btn-ghost btn-sm" :disabled="!auditFiltered.length" @click="exportAuditCsv">
            <Download :size="14" /> 导出 CSV
          </button>
          <button class="btn btn-danger btn-sm" :disabled="!audit.length" @click="clearAudit">
            <Trash2 :size="14" /> 清空
          </button>
        </div>

        <div v-if="topActions.length" class="flex flex-wrap gap-2 mb-4">
          <span
            v-for="[action, n] in topActions"
            :key="action"
            class="badge badge-neutral"
          >
            {{ actionLabel[action] ?? action }} <span class="tabular-nums opacity-70">{{ n }}</span>
          </span>
        </div>

        <div v-if="auditFiltered.length === 0" class="card py-16 flex flex-col items-center text-center">
          <span class="grid place-items-center size-12 rounded-2xl bg-surface-2 text-ink-muted mb-3">
            <Inbox :size="22" />
          </span>
          <p class="text-sm font-medium">还没有操作记录</p>
          <p class="text-[13px] text-ink-muted mt-1">换个操作类型或日期范围试试。</p>
        </div>

        <div v-else class="card divide-y divide-line overflow-hidden">
          <div v-for="log in auditPageItems" :key="log.id" class="flex items-center gap-3 px-4 py-3">
            <span class="badge badge-neutral shrink-0">{{ actionLabel[log.action] ?? log.action }}</span>
            <span class="text-[13px] truncate flex-1" :title="log.detail">{{ log.target || log.detail || '—' }}</span>
            <span class="text-[12px] text-ink-muted font-mono shrink-0 hidden sm:inline">{{ log.ip || '—' }}</span>
            <span class="text-[12px] text-ink-muted shrink-0">{{ formatDateTime(log.created_at) }}</span>
          </div>
          <PaginationBar v-model:page="auditPage" :total="auditFiltered.length" :per="PER_AUDIT" />
        </div>
      </div>

      <!-- 错误日志 -->
      <div v-else>
        <!-- 统计卡：错误种类 / 累计触发 -->
        <div class="grid grid-cols-2 gap-3 mb-5">
          <div class="card p-4">
            <div class="text-[12.5px] text-ink-muted flex items-center gap-1.5"><Bug :size="15" /> 错误种类</div>
            <div class="text-[24px] font-semibold tabular-nums mt-0.5" :class="errorTotal > 0 ? 'text-danger' : ''">
              {{ errorTotal }}
            </div>
          </div>
          <div class="card p-4">
            <div class="text-[12.5px] text-ink-muted flex items-center gap-1.5"><Gauge :size="15" /> 累计触发</div>
            <div class="text-[24px] font-semibold tabular-nums mt-0.5" :class="errorHits > 0 ? 'text-danger' : ''">
              {{ errorHits }}
            </div>
          </div>
        </div>

        <!-- 工具栏：关键词搜索 / 清空 -->
        <div class="flex items-center gap-2 mb-4">
          <input
            v-model="errorKeyword"
            class="input"
            type="search"
            placeholder="搜索错误信息 / 来源 / URL…"
          />
          <button class="btn btn-danger btn-sm shrink-0" :disabled="!errors.length" @click="clearErrors">
            <Trash2 :size="14" /> 清空
          </button>
        </div>

        <div v-if="errorsFiltered.length === 0" class="card py-16 flex flex-col items-center text-center">
          <span class="grid place-items-center size-12 rounded-2xl bg-success-soft text-success mb-3">
            <Inbox :size="22" />
          </span>
          <p class="text-sm font-medium">{{ errors.length === 0 ? '没有错误记录' : '没有匹配的错误记录' }}</p>
          <p class="text-[13px] text-ink-muted mt-1">
            {{ errors.length === 0 ? '前端上报的异常会聚合到这里。' : '换个关键词试试。' }}
          </p>
        </div>

        <div v-else class="space-y-2.5">
          <article v-for="item in errorsFiltered" :key="item.id" class="card p-4">
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
