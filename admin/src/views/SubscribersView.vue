<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Loader2, Trash2, Send, Users, Inbox, Tags, X, Check } from '@lucide/vue';
import { api, ApiError, type components } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { toast } from '../lib/toast';

type Sub = components['schemas']['SubscriberItem'];

const items = ref<Sub[]>([]);
const counts = ref({ total: 0, active: 0, pending: 0, unsubscribed: 0 });
const groups = ref<Array<{ name: string; count: number }>>([]);
const enabled = ref(false);
const loading = ref(true);
const filter = ref<'all' | 'active' | 'pending' | 'unsubscribed'>('all');
const groupFilter = ref('');
const subject = ref('');
const body = ref('');
const bcGroups = ref<string[]>([]);
const sending = ref(false);

/** 正在编辑分组的订阅者（null 表示弹窗关闭） */
const editing = ref<Sub | null>(null);
const editGroups = ref('');
const editSaving = ref(false);

const visible = computed(() =>
  items.value.filter((s) => {
    if (filter.value !== 'all' && s.status !== filter.value) return false;
    if (groupFilter.value && !(s.groups ?? []).includes(groupFilter.value)) return false;
    return true;
  })
);

const statusMeta: Record<string, { label: string; badge: string }> = {
  active: { label: '已确认', badge: 'badge-success' },
  pending: { label: '待确认', badge: 'badge-warning' },
  unsubscribed: { label: '已退订', badge: 'badge-neutral' }
};

/** 分组不是独立表，而是订阅者行上的字段；这里按当前列表实时汇总统计 */
function recomputeGroups(): void {
  const map = new Map<string, number>();
  for (const s of items.value) {
    for (const g of s.groups ?? []) map.set(g, (map.get(g) ?? 0) + 1);
  }
  groups.value = [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  if (groupFilter.value && !map.has(groupFilter.value)) groupFilter.value = '';
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const data = await api.listSubscribers();
    items.value = data.subscribers ?? [];
    counts.value = data.counts;
    groups.value = data.groups ?? [];
    enabled.value = data.enabled;
    recomputeGroups();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '加载订阅者失败');
  } finally {
    loading.value = false;
  }
}

async function remove(sub: Sub): Promise<void> {
  if (!window.confirm(`删除订阅者 ${sub.email}？`)) return;
  try {
    await api.deleteSubscriber(sub.id);
    items.value = items.value.filter((s) => s.id !== sub.id);
    recomputeGroups();
    toast.success('已删除');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '删除失败');
  }
}

/* ---------- 单个编辑：分组 ---------- */

function openEdit(sub: Sub): void {
  editing.value = sub;
  editGroups.value = (sub.groups ?? []).join(', ');
  editSaving.value = false;
}

function closeEdit(): void {
  editing.value = null;
  editGroups.value = '';
  editSaving.value = false;
}

/** 逗号 / 中文逗号 / 顿号 / 分号 / 换行都算分隔符，方便直接粘贴 */
function parseGroups(raw: string): string[] {
  return [...new Set(raw.split(/[,，、;；\n]/).map((g) => g.trim()).filter(Boolean))];
}

async function saveEdit(): Promise<void> {
  if (!editing.value) return;
  const target = editing.value;
  const next = parseGroups(editGroups.value);
  if (next.length > 50) return toast.error('分组最多 50 个');
  editSaving.value = true;
  try {
    const r = await api.updateSubscriber(target.id, { groups: next });
    const idx = items.value.findIndex((s) => s.id === target.id);
    if (idx >= 0) items.value.splice(idx, 0, { ...items.value[idx], groups: r.groups ?? next });
    recomputeGroups();
    toast.success('分组已更新');
    closeEdit();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '保存失败');
  } finally {
    editSaving.value = false;
  }
}

/* ---------- 群发 ---------- */

async function broadcast(): Promise<void> {
  if (!subject.value.trim()) return toast.error('请填写邮件主题');
  if (!body.value.trim()) return toast.error('请填写邮件正文');
  sending.value = true;
  try {
    const r = await api.broadcast({
      subject: subject.value.trim(),
      body: body.value.trim(),
      groups: bcGroups.value
    });
    if (r.queued === 0) {
      toast.error('所选分组里没有已确认的订阅者，未入队');
    } else {
      toast.success(`已入队 ${r.queued} 封`);
      subject.value = '';
      body.value = '';
    }
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '群发失败');
  } finally {
    sending.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div v-if="!enabled && !loading" class="card mb-5 p-4 border-warning/40 bg-warning-soft text-[13px] leading-relaxed">
      <p class="font-medium text-warning">未配置发信服务</p>
      <p class="text-ink-soft mt-1">可以查看与管理名单，但无法发送确认邮件或群发。请在 <code>.env</code> 配置 SMTP 或 Resend。</p>
    </div>

    <!-- 统计卡 -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
      <button
        v-for="tab in ([['all','全部',counts.total],['active','已确认',counts.active],['pending','待确认',counts.pending],['unsubscribed','已退订',counts.unsubscribed]] as const)"
        :key="tab[0]"
        class="card p-4 text-left transition-colors"
        :class="filter === tab[0] ? 'border-accent/50 bg-accent-soft' : 'hover:border-line-strong'"
        @click="filter = tab[0]"
      >
        <div class="text-[24px] font-semibold tabular-nums" :class="filter === tab[0] ? 'text-accent' : ''">{{ tab[2] }}</div>
        <div class="text-[12.5px] text-ink-muted mt-0.5">{{ tab[1] }}</div>
      </button>
    </div>

    <!-- 群发：分组多选 + 主题 + 正文 -->
    <section class="card p-4 mb-5">
      <h2 class="text-[14px] font-semibold mb-3">群发通知</h2>

      <div class="mb-3">
        <p class="label mb-1.5">发送范围（不勾选 = 全部已确认订阅者）</p>
        <div v-if="groups.length" class="flex flex-wrap gap-x-4 gap-y-2">
          <label v-for="g in groups" :key="g.name" class="flex items-center gap-1.5 text-[13px] cursor-pointer select-none">
            <input v-model="bcGroups" type="checkbox" class="accent-[var(--accent)] size-4" :value="g.name" />
            {{ g.name }}<span class="text-ink-muted">（{{ g.count }}）</span>
          </label>
        </div>
        <p v-else class="hint">还没有分组，将发送给全部已确认订阅者。先在下方订阅者的「编辑分组」里创建分组。</p>
      </div>

      <div class="flex flex-col gap-2">
        <input v-model="subject" class="input" placeholder="邮件主题" />
        <textarea v-model="body" class="textarea" rows="4" placeholder="邮件正文（必填）" />
        <div class="flex items-center justify-between gap-3">
          <p class="hint">邮件进入发件队列，由定时任务逐条投递（每 5 分钟一批）。</p>
          <button class="btn btn-primary shrink-0" :disabled="sending || !enabled" @click="broadcast">
            <Loader2 v-if="sending" :size="16" class="animate-spin" /><Send v-else :size="16" /> 发送
          </button>
        </div>
      </div>
    </section>

    <!-- 分组筛选 -->
    <div v-if="groups.length" class="flex flex-wrap items-center gap-2 mb-4">
      <button
        class="btn btn-ghost btn-sm"
        :class="!groupFilter ? 'bg-surface-2 font-medium' : ''"
        @click="groupFilter = ''"
      >
        全部分组
      </button>
      <button
        v-for="g in groups"
        :key="g.name"
        class="btn btn-ghost btn-sm"
        :class="groupFilter === g.name ? 'bg-accent-soft text-accent' : ''"
        @click="groupFilter = groupFilter === g.name ? '' : g.name"
      >
        {{ g.name }}<span class="text-ink-muted">· {{ g.count }}</span>
      </button>
    </div>

    <div v-if="loading" class="card h-40 shimmer" />
    <div v-else-if="visible.length === 0" class="card py-16 flex flex-col items-center text-center">
      <span class="grid place-items-center size-12 rounded-2xl bg-surface-2 text-ink-muted mb-3"><Inbox :size="22" /></span>
      <p class="text-sm font-medium">{{ groupFilter || filter !== 'all' ? '没有符合条件的订阅者' : '没有订阅者' }}</p>
      <p class="text-[13px] text-ink-muted mt-1">{{ groupFilter || filter !== 'all' ? '换一个筛选条件试试。' : '读者在站点订阅后会出现在这里。' }}</p>
    </div>

    <div v-else class="card divide-y divide-line overflow-hidden">
      <div v-for="sub in visible" :key="sub.id" class="flex items-center gap-3 px-4 py-3">
        <span class="grid place-items-center size-8 rounded-lg bg-surface-2 text-ink-muted shrink-0"><Users :size="15" /></span>
        <div class="flex-1 min-w-0">
          <p class="text-[13.5px] truncate">{{ sub.email }}</p>
          <p class="text-[12px] text-ink-muted mt-0.5 flex flex-wrap items-center gap-1.5">
            <span>{{ formatDateTime(sub.created_at) }}</span>
            <span
              v-for="g in sub.groups ?? []"
              :key="g"
              class="badge badge-neutral !py-0 !px-1.5 !text-[11px]"
            >{{ g }}</span>
          </p>
        </div>
        <span class="badge shrink-0" :class="statusMeta[sub.status]?.badge">{{ statusMeta[sub.status]?.label ?? sub.status }}</span>
        <button class="btn btn-ghost btn-sm shrink-0" title="编辑分组" @click="openEdit(sub)">
          <Tags :size="14" />
        </button>
        <button class="btn btn-ghost btn-sm hover:text-danger shrink-0" title="删除" @click="remove(sub)"><Trash2 :size="14" /></button>
      </div>
    </div>

    <!-- 编辑分组弹窗 -->
    <div
      v-if="editing"
      class="fixed inset-0 z-50 bg-black/45 backdrop-blur-sm p-4 grid place-items-center"
      @click.self="closeEdit"
    >
      <div class="card w-full max-w-md p-5">
        <div class="flex items-center justify-between mb-4">
          <div>
            <h3 class="text-[15px] font-semibold flex items-center gap-2"><Tags :size="16" /> 编辑分组</h3>
            <p class="text-[12.5px] text-ink-muted mt-0.5 truncate">{{ editing.email }}</p>
          </div>
          <button class="btn btn-ghost btn-sm" @click="closeEdit"><X :size="16" /></button>
        </div>

        <label class="label" for="editGroups">分组（用逗号分隔，留空表示不分组）</label>
        <input
          id="editGroups"
          v-model="editGroups"
          class="input"
          placeholder="例如：朋友, RSS, 内测"
          @keydown.enter.prevent="saveEdit"
        />
        <p class="hint">输入新名字即可新建分组，改名后其他订阅者不受影响；多个分组请用英文或中文逗号分隔。</p>

        <div class="flex justify-end gap-2 mt-4">
          <button class="btn" :disabled="editSaving" @click="closeEdit">取消</button>
          <button class="btn btn-primary" :disabled="editSaving" @click="saveEdit">
            <Loader2 v-if="editSaving" :size="16" class="animate-spin" /><Check v-else :size="16" /> 保存
          </button>
        </div>
      </div>
    </div>
  </div>
</template>