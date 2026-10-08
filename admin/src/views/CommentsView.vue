<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  Check, Clock, Trash2, MessageSquare, Loader2, Inbox, Pin, Star, Heart, Search, Sparkles
} from '@lucide/vue';
import { api, ApiError, type CommentAdminItem } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { toast } from '../lib/toast';

const route = useRoute();

const items = ref<CommentAdminItem[]>([]);
const loading = ref(true);
const busy = ref(false);
const status = ref<'all' | 'pending' | 'approved'>('all');
const keyword = ref('');
const selected = ref<Set<string>>(new Set());

/* 评论 AI：服务端未配置 AI 时 aiPing 返回 404，功能整块隐藏 */
const aiAvailable = ref(false);
const aiSummarizing = ref(false);
const aiSummary = ref('');
const aiSummaryEmpty = ref(false);
const aiSummaryCached = ref(false);
const screenText = ref('');
const screenBusy = ref(false);
const screenResult = ref<{ spam: boolean; reason: string } | null>(null);

const pendingCount = computed(() => items.value.filter((c) => c.status === 'pending').length);

/* 建立 id → 评论映射，用于展示「回复了某人」的父评论作者 */
const byId = computed(() => {
  const map = new Map<string, CommentAdminItem>();
  for (const c of items.value) map.set(c.id, c);
  return map;
});

function parentLabel(item: CommentAdminItem): string {
  if (!item.parent_id) return '';
  const parent = byId.value.get(item.parent_id);
  return parent?.author || '匿名';
}

/* 状态筛选 + 关键词（作者 / 内容 / 所属文章）前端过滤 */
const visible = computed(() => {
  const q = keyword.value.trim().toLowerCase();
  return items.value.filter((c) => {
    if (status.value !== 'all' && c.status !== status.value) return false;
    if (!q) return true;
    return `${c.author || ''} ${c.content || ''} ${c.post_title || ''}`.toLowerCase().includes(q);
  });
});

const allVisibleSelected = computed(
  () => visible.value.length > 0 && visible.value.every((c) => selected.value.has(c.id))
);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const data = await api.listComments('all');
    items.value = data.comments ?? [];
    selected.value = new Set();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '加载评论失败');
  } finally {
    loading.value = false;
  }
}

function toggle(id: string): void {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

function toggleAll(): void {
  selected.value = allVisibleSelected.value
    ? new Set()
    : new Set(visible.value.map((c) => c.id));
}

async function setStatus(item: CommentAdminItem, next: 'approved' | 'pending'): Promise<void> {
  try {
    await api.updateComment(item.id, { status: next });
    item.status = next;
    toast.success(next === 'approved' ? '已通过' : '已转为待审');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '操作失败');
  }
}

/* 置顶 / 精选切换（就地更新，不重拉整表） */
async function toggleFlag(item: CommentAdminItem, key: 'pinned' | 'featured'): Promise<void> {
  const next = !item[key];
  try {
    await api.updateComment(item.id, { [key]: next });
    item[key] = next ? 1 : 0;
    if (key === 'pinned') toast.success(next ? '已置顶' : '已取消置顶');
    else toast.success(next ? '已精选' : '已取消精选');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '操作失败');
  }
}

async function remove(item: CommentAdminItem): Promise<void> {
  if (!window.confirm(`删除 ${item.author} 的这条评论？`)) return;
  try {
    await api.deleteComment(item.id);
    items.value = items.value.filter((c) => c.id !== item.id);
    toast.success('已删除');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '删除失败');
  }
}

async function bulk(op: 'approve' | 'pending' | 'delete'): Promise<void> {
  const ids = [...selected.value];
  if (!ids.length) return;
  if (op === 'delete' && !window.confirm(`确定删除选中的 ${ids.length} 条评论？`)) return;

  busy.value = true;
  try {
    const result = await api.bulkComments(op, ids);
    toast.success(`已处理 ${result.updated} 条`);
    await load();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '批量操作失败');
  } finally {
    busy.value = false;
  }
}

/* AI 汇总最近评论要点 */
async function summarizeComments(): Promise<void> {
  aiSummarizing.value = true;
  try {
    const r = await api.aiSummarizeComments();
    aiSummary.value = r.summary || '';
    aiSummaryEmpty.value = !!r.empty;
    aiSummaryCached.value = !!r.cached;
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '汇总失败');
  } finally {
    aiSummarizing.value = false;
  }
}

/* AI 单条垃圾筛查 */
async function screenComment(): Promise<void> {
  const text = screenText.value.trim();
  if (!text) return;
  screenBusy.value = true;
  try {
    screenResult.value = await api.aiScreenComment(text);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '检测失败');
  } finally {
    screenBusy.value = false;
  }
}

/* 直达 /comments/pending 时默认落在待审筛选 */
watch(
  () => route.name,
  (name) => { if (name === 'comments-pending') status.value = 'pending'; }
);

onMounted(() => {
  if (route.name === 'comments-pending') status.value = 'pending';
  void load();
  /* 探测 AI 是否可用：服务端未配置时 404，自动隐藏 AI 区块 */
  void api
    .aiPing()
    .then(() => { aiAvailable.value = true; })
    .catch(() => undefined);
});
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center gap-3 mb-5">
      <div class="flex gap-1 p-1 rounded-xl bg-surface-2">
        <button
          v-for="tab in ([
            ['all', '全部', items.length],
            ['pending', '待审核', pendingCount],
            ['approved', '已通过', items.length - pendingCount]
          ] as const)"
          :key="tab[0]"
          class="h-7 px-3 rounded-[8px] text-[13px] font-medium transition-all whitespace-nowrap"
          :class="status === tab[0] ? 'bg-surface text-ink shadow-xs' : 'text-ink-muted hover:text-ink'"
          @click="status = tab[0]"
        >
          {{ tab[1] }} <span class="ml-1 tabular-nums text-ink-muted">{{ tab[2] }}</span>
        </button>
      </div>

      <div v-if="items.length > 0" class="relative flex-1 min-w-[200px]">
        <Search :size="15" class="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none" />
        <input v-model="keyword" class="input pl-9" type="search" placeholder="搜索作者、内容或文章…" />
      </div>
    </div>

    <!-- AI 评论助手：服务端未配置 AI 时整块隐藏 -->
    <div v-if="aiAvailable" class="card p-4 mb-5 space-y-3">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-[13px] font-semibold text-ink-soft flex items-center gap-1.5">
          <Sparkles :size="15" class="text-accent" /> AI 评论助手
        </span>
        <button class="btn btn-sm btn-secondary ml-auto" :disabled="aiSummarizing" @click="summarizeComments">
          <Loader2 v-if="aiSummarizing" :size="14" class="animate-spin" />
          <Sparkles v-else :size="14" />
          汇总最近评论
        </button>
      </div>

      <div v-if="aiSummary || aiSummaryEmpty" class="rounded-xl bg-surface-2 p-3">
        <div class="flex items-center gap-2 mb-1.5">
          <span class="text-[12.5px] font-semibold">评论摘要</span>
          <span class="badge badge-neutral ml-auto">{{ aiSummaryCached ? '缓存' : '新生成' }}</span>
        </div>
        <p v-if="aiSummaryEmpty" class="text-[13px] text-ink-muted">最近还没有可汇总的评论。</p>
        <p v-else class="text-[13px] leading-relaxed whitespace-pre-line">{{ aiSummary }}</p>
      </div>

      <div>
        <label class="label">垃圾评论检测</label>
        <textarea
          v-model="screenText"
          class="input"
          rows="2"
          maxlength="1000"
          placeholder="粘贴一条评论内容，让 AI 判断是否为垃圾…"
        ></textarea>
        <div class="flex items-center gap-2 mt-2">
          <button class="btn btn-sm btn-secondary" :disabled="screenBusy || !screenText.trim()" @click="screenComment">
            <Loader2 v-if="screenBusy" :size="14" class="animate-spin" />
            检测
          </button>
          <span
            v-if="screenResult"
            class="text-[13px]"
            :class="screenResult.spam ? 'text-danger font-semibold' : 'text-success'"
          >
            {{ screenResult.spam ? '疑似垃圾' : '正常' }}{{ screenResult.reason ? '：' + screenResult.reason : '' }}
          </span>
        </div>
      </div>
    </div>

    <!-- 批量操作条 -->
    <Transition name="fade">
      <div
        v-if="selected.size > 0"
        class="sticky top-16 z-10 mb-4 flex items-center gap-2 rounded-xl border border-accent/30 bg-accent-soft px-3 py-2"
      >
        <span class="text-[13px] text-accent font-medium">已选 {{ selected.size }} 条</span>
        <div class="ml-auto flex gap-2">
          <button class="btn btn-sm btn-secondary" :disabled="busy" @click="bulk('approve')">
            <Check :size="14" /> 通过
          </button>
          <button class="btn btn-sm btn-secondary" :disabled="busy" @click="bulk('pending')">
            <Clock :size="14" /> 转待审
          </button>
          <button class="btn btn-sm btn-danger" :disabled="busy" @click="bulk('delete')">
            <Loader2 v-if="busy" :size="14" class="animate-spin" />
            <Trash2 v-else :size="14" /> 删除
          </button>
        </div>
      </div>
    </Transition>

    <div v-if="loading" class="space-y-2.5">
      <div v-for="i in 4" :key="i" class="card h-[92px] shimmer" />
    </div>

    <div v-else-if="visible.length === 0" class="card py-16 flex flex-col items-center text-center">
      <span class="grid place-items-center size-12 rounded-2xl bg-surface-2 text-ink-muted mb-3">
        <Inbox :size="22" />
      </span>
      <p class="text-sm font-medium">
        {{ keyword ? '没有匹配的评论' : status === 'pending' ? '没有待审核的评论' : '还没有评论' }}
      </p>
      <p class="text-[13px] text-ink-muted mt-1">
        {{ keyword ? '换个关键词试试。' : '读者留言后会出现在这里。' }}
      </p>
    </div>

    <div v-else class="space-y-2.5">
      <!-- 全选 -->
      <label class="flex items-center gap-2 px-1 text-[12.5px] text-ink-muted cursor-pointer select-none">
        <input
          type="checkbox"
          class="accent-[var(--accent)] size-4"
          :checked="allVisibleSelected"
          @change="toggleAll"
        />
        全选当前列表
      </label>

      <article
        v-for="item in visible"
        :key="item.id"
        class="card p-4 flex gap-3.5"
        :class="item.status === 'pending' ? 'border-warning/40' : item.pinned ? 'border-accent/40' : ''"
      >
        <input
          type="checkbox"
          class="mt-1 accent-[var(--accent)] size-4 shrink-0"
          :checked="selected.has(item.id)"
          @change="toggle(item.id)"
        />

        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-[14px] font-semibold">{{ item.author || '匿名' }}</span>
            <span class="badge" :class="item.status === 'pending' ? 'badge-warning' : 'badge-success'">
              {{ item.status === 'pending' ? '待审核' : '已通过' }}
            </span>
            <span v-if="item.parent_id" class="badge badge-neutral">回复 {{ parentLabel(item) }}</span>
            <span v-if="item.pinned" class="badge badge-info inline-flex items-center gap-1">
              <Pin :size="11" /> 置顶
            </span>
            <span v-if="item.featured" class="badge badge-warning inline-flex items-center gap-1">
              <Star :size="11" /> 精选
            </span>
            <span class="inline-flex items-center gap-1 text-[12px] text-ink-muted">
              <Heart :size="12" /> {{ item.likes || 0 }}
            </span>
            <span class="text-[12px] text-ink-muted ml-auto">{{ formatDateTime(item.date) }}</span>
          </div>

          <p class="text-[13.5px] mt-2 leading-relaxed whitespace-pre-wrap break-words">{{ item.content }}</p>

          <a
            v-if="item.post_title"
            class="inline-flex items-center gap-1 text-[12px] text-ink-muted hover:text-accent mt-2 transition-colors"
            :href="`/posts/${encodeURIComponent(item.post_id)}/`"
            target="_blank"
            rel="noopener"
          >
            <MessageSquare :size="12" /> {{ item.post_title }}
          </a>
          <span v-else class="text-[12px] text-ink-muted mt-2 inline-block">留言板</span>
        </div>

        <div class="flex flex-col gap-1 shrink-0">
          <button
            v-if="item.status === 'pending'"
            class="btn btn-sm btn-secondary"
            @click="setStatus(item, 'approved')"
          >
            <Check :size="14" /> 通过
          </button>
          <button v-else class="btn btn-sm btn-ghost" @click="setStatus(item, 'pending')">
            <Clock :size="14" /> 待审
          </button>
          <button
            class="btn btn-sm btn-ghost whitespace-nowrap"
            :class="item.pinned ? 'text-accent' : ''"
            @click="toggleFlag(item, 'pinned')"
          >
            <Pin :size="14" /> {{ item.pinned ? '取消置顶' : '置顶' }}
          </button>
          <button
            class="btn btn-sm btn-ghost whitespace-nowrap"
            :class="item.featured ? 'text-accent' : ''"
            @click="toggleFlag(item, 'featured')"
          >
            <Star :size="14" /> {{ item.featured ? '取消精选' : '精选' }}
          </button>
          <button class="btn btn-sm btn-ghost hover:text-danger" @click="remove(item)">
            <Trash2 :size="14" />
          </button>
        </div>
      </article>
    </div>
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
