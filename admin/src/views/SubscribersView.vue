<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Loader2, Trash2, Send, Users, Inbox } from '@lucide/vue';
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
const selectedGroup = ref('');
const subject = ref('');
const sending = ref(false);

const visible = computed(() =>
  filter.value === 'all' ? items.value : items.value.filter((s) => s.status === filter.value)
);
const statusMeta: Record<string, { label: string; badge: string }> = {
  active: { label: '已确认', badge: 'badge-success' },
  pending: { label: '待确认', badge: 'badge-warning' },
  unsubscribed: { label: '已退订', badge: 'badge-neutral' }
};

async function load(): Promise<void> {
  loading.value = true;
  try {
    const data = await api.listSubscribers();
    items.value = data.subscribers ?? [];
    counts.value = data.counts;
    groups.value = data.groups ?? [];
    enabled.value = data.enabled;
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
    toast.success('已删除');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '删除失败');
  }
}

async function broadcast(): Promise<void> {
  if (!subject.value.trim()) return toast.error('请填写邮件主题');
  try {
    const r = await api.broadcast({ subject: subject.value.trim(), groups: selectedGroup.value ? [selectedGroup.value] : [] });
    toast.success(`已入队 ${r.queued} 封`);
    subject.value = '';
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '群发失败');
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

    <!-- 群发 -->
    <section class="card p-4 mb-5">
      <h2 class="text-[14px] font-semibold mb-3">群发通知</h2>
      <div class="flex flex-wrap gap-2">
        <select v-model="selectedGroup" class="select !w-auto min-w-[140px]">
          <option value="">全部订阅者</option>
          <option v-for="g in groups" :key="g.name" :value="g.name">{{ g.name }}（{{ g.count }}）</option>
        </select>
        <input v-model="subject" class="input flex-1 min-w-[200px]" placeholder="邮件主题" />
        <button class="btn btn-primary" :disabled="sending || !enabled" @click="broadcast">
          <Loader2 v-if="sending" :size="16" class="animate-spin" /><Send v-else :size="16" /> 发送
        </button>
      </div>
      <p class="hint">邮件进入发件队列，由定时任务逐条投递（每 5 分钟一批）。</p>
    </section>

    <div v-if="loading" class="card h-40 shimmer" />
    <div v-else-if="visible.length === 0" class="card py-16 flex flex-col items-center text-center">
      <span class="grid place-items-center size-12 rounded-2xl bg-surface-2 text-ink-muted mb-3"><Inbox :size="22" /></span>
      <p class="text-sm font-medium">没有订阅者</p>
      <p class="text-[13px] text-ink-muted mt-1">读者在站点订阅后会出现在这里。</p>
    </div>

    <div v-else class="card divide-y divide-line overflow-hidden">
      <div v-for="sub in visible" :key="sub.id" class="flex items-center gap-3 px-4 py-3">
        <span class="grid place-items-center size-8 rounded-lg bg-surface-2 text-ink-muted shrink-0"><Users :size="15" /></span>
        <div class="flex-1 min-w-0">
          <p class="text-[13.5px] truncate">{{ sub.email }}</p>
          <p class="text-[12px] text-ink-muted mt-0.5">
            {{ formatDateTime(sub.created_at) }}
            <span v-if="sub.groups?.length"> · {{ sub.groups.join(' / ') }}</span>
          </p>
        </div>
        <span class="badge shrink-0" :class="statusMeta[sub.status]?.badge">{{ statusMeta[sub.status]?.label ?? sub.status }}</span>
        <button class="btn btn-ghost btn-sm hover:text-danger shrink-0" @click="remove(sub)"><Trash2 :size="14" /></button>
      </div>
    </div>
  </div>
</template>