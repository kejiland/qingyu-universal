<script setup lang="ts">
import { computed, onMounted, ref, type Component } from 'vue';
import { useRouter } from 'vue-router';
import { Eye, Heart, MessageSquare, Flame, Download, Inbox } from '@lucide/vue';
import { api, ApiError, type PostAnalyticsItem } from '../lib/api';
import { formatDate, postStatusMeta } from '../lib/format';
import { downloadText } from '../lib/transfer';
import { toast } from '../lib/toast';

type Range = 'all' | '30' | '7';

const router = useRouter();

const ranges: Array<{ key: Range; label: string }> = [
  { key: 'all', label: '全部' },
  { key: '30', label: '近 30 天' },
  { key: '7', label: '近 7 天' }
];

const range = ref<Range>('all');
const loading = ref(true);
const items = ref<PostAnalyticsItem[]>([]);
const summary = ref({ views: 0, likes: 0, comments: 0, posts: 0 });

/* ---------- 汇总卡 ---------- */
const cards = computed<Array<{ label: string; icon: Component; value?: number; text?: string }>>(() => [
  { label: '总浏览', icon: Eye, value: summary.value.views },
  { label: '总点赞', icon: Heart, value: summary.value.likes },
  { label: '总评论', icon: MessageSquare, value: summary.value.comments },
  { label: '最热文章', icon: Flame, text: items.value[0]?.title || '—' }
]);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const data = await api.postAnalytics(range.value);
    items.value = data.items ?? [];
    summary.value = data.summary ?? { views: 0, likes: 0, comments: 0, posts: items.value.length };
  } catch (e) {
    items.value = [];
    summary.value = { views: 0, likes: 0, comments: 0, posts: 0 };
    toast.error(e instanceof ApiError ? e.message : '加载统计失败');
  } finally {
    loading.value = false;
  }
}

function setRange(next: Range): void {
  if (range.value === next) return;
  range.value = next;
  void load();
}

/* ---------- 迷你趋势 ---------- */
function sparkPoints(trend: PostAnalyticsItem['trend']): string {
  const values = (trend ?? []).map((point) => Number(point.views) || 0);
  if (values.length < 2) return '';
  const width = 96;
  const height = 26;
  const max = Math.max(1, ...values);
  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - (value / max) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/* ---------- 导出 CSV（与原版同一套格式：BOM + CRLF + 全字段引号） ---------- */
function csvCell(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function exportCsv(): void {
  if (items.value.length === 0) {
    toast.error('没有可导出的数据');
    return;
  }
  const header = ['id', 'title', 'status', 'date', 'views', 'likes', 'comments', 'score'];
  const lines = [header.map(csvCell).join(',')];
  for (const item of items.value) {
    lines.push(
      [item.id, item.title, item.status, item.date, item.views, item.likes, item.comments, item.score]
        .map(csvCell)
        .join(',')
    );
  }
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  downloadText(`post-analytics-${day}.csv`, `\ufeff${lines.join('\r\n')}\r\n`, 'text/csv;charset=utf-8');
  toast.success('已导出');
}

onMounted(load);
</script>

<template>
  <div>
    <!-- 工具条：范围切换 + 导出 -->
    <div class="flex flex-wrap items-center gap-3 mb-5">
      <div class="flex gap-1 p-1 rounded-xl bg-surface-2">
        <button
          v-for="tab in ranges"
          :key="tab.key"
          class="h-7 px-3 rounded-[8px] text-[13px] font-medium transition-all whitespace-nowrap"
          :class="range === tab.key ? 'bg-surface text-ink shadow-xs' : 'text-ink-muted hover:text-ink'"
          @click="setRange(tab.key)"
        >{{ tab.label }}</button>
      </div>
      <div class="flex-1 min-w-0" />
      <button class="btn btn-secondary" :disabled="loading || items.length === 0" @click="exportCsv">
        <Download :size="16" />
        导出 CSV
      </button>
    </div>

    <!-- 加载骨架 -->
    <div v-if="loading" class="space-y-4">
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div v-for="i in 4" :key="i" class="card p-4 h-[78px] shimmer" />
      </div>
      <div class="card p-4 space-y-3">
        <div v-for="i in 6" :key="i" class="h-10 rounded-lg bg-surface-2 shimmer" />
      </div>
    </div>

    <div v-else class="space-y-5">
      <!-- 汇总卡 -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div v-for="card in cards" :key="card.label" class="card p-4">
          <div class="flex items-center gap-1.5 text-[12.5px] text-ink-muted mb-1">
            <component :is="card.icon" :size="13" />
            {{ card.label }}
          </div>
          <div
            v-if="card.text !== undefined"
            class="text-[15px] font-semibold truncate"
            :title="card.text"
          >{{ card.text }}</div>
          <div v-else class="text-[24px] font-semibold tabular-nums">{{ (card.value ?? 0).toLocaleString() }}</div>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-if="items.length === 0" class="card py-16 flex flex-col items-center text-center">
        <span class="grid place-items-center size-12 rounded-2xl bg-surface-2 text-ink-muted mb-3">
          <Inbox :size="22" />
        </span>
        <p class="text-sm font-medium">暂无统计数据</p>
        <p class="text-[13px] text-ink-muted mt-1">文章被访问后，这里会显示浏览、点赞与评论排行。</p>
      </div>

      <!-- 排行表 -->
      <section v-else class="card overflow-hidden">
        <div
          class="hidden md:flex items-center gap-4 px-4 py-2.5 border-b border-line text-[11px] font-semibold uppercase tracking-wider text-ink-muted"
        >
          <span class="w-6 shrink-0">#</span>
          <span class="flex-1 min-w-0">标题</span>
          <span class="w-[68px] shrink-0 text-right">浏览</span>
          <span class="w-[68px] shrink-0 text-right">点赞</span>
          <span class="w-[68px] shrink-0 text-right">评论</span>
          <span class="w-[76px] shrink-0 text-right">得分</span>
          <span class="w-[104px] shrink-0 text-right">趋势</span>
        </div>

        <button
          v-for="(item, index) in items"
          :key="item.id"
          class="w-full flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 border-b border-line last:border-b-0 text-left hover:bg-surface-2 focus-visible:bg-surface-2 transition-colors"
          :title="`编辑《${item.title || '未命名'}》`"
          @click="router.push({ name: 'post-edit', params: { id: item.id } })"
        >
          <span
            class="w-6 shrink-0 text-center text-[12px] tabular-nums"
            :class="index < 3 ? 'text-accent font-semibold' : 'text-ink-muted'"
          >{{ index + 1 }}</span>

          <span class="flex-1 min-w-[140px] min-w-0">
            <span class="flex items-center gap-2 min-w-0">
              <span class="text-[14px] font-medium truncate">{{ item.title || '未命名' }}</span>
              <span class="badge shrink-0" :class="postStatusMeta[item.status]?.badge ?? 'badge-neutral'">
                {{ postStatusMeta[item.status]?.label ?? item.status }}
              </span>
            </span>
            <span class="block text-[11.5px] text-ink-muted mt-0.5 truncate">{{ formatDate(item.date) }}</span>
          </span>

          <!-- 数字列：桌面四列对齐，移动端折成一行 -->
          <span class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-muted tabular-nums shrink-0 md:contents">
            <span class="md:w-[68px] md:shrink-0 md:text-right">
              <b class="md:hidden font-medium text-ink">浏览 </b>{{ item.views.toLocaleString() }}
            </span>
            <span class="md:w-[68px] md:shrink-0 md:text-right">
              <b class="md:hidden font-medium text-ink">点赞 </b>{{ item.likes.toLocaleString() }}
            </span>
            <span class="md:w-[68px] md:shrink-0 md:text-right">
              <b class="md:hidden font-medium text-ink">评论 </b>{{ item.comments.toLocaleString() }}
            </span>
            <span class="md:w-[76px] md:shrink-0 md:text-right text-ink font-medium">
              <b class="md:hidden font-medium">得分 </b>{{ item.score.toLocaleString() }}
            </span>
          </span>

          <span class="w-[104px] shrink-0 flex justify-end">
            <svg
              v-if="sparkPoints(item.trend)"
              viewBox="0 0 96 26"
              preserveAspectRatio="none"
              class="w-24 h-[26px]"
              aria-hidden="true"
            >
              <polyline
                :points="sparkPoints(item.trend)"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linejoin="round"
                stroke-linecap="round"
                class="text-accent"
              />
            </svg>
            <span v-else class="text-[12px] text-ink-muted">—</span>
          </span>
        </button>
      </section>
    </div>
  </div>
</template>