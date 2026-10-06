<script setup lang="ts">
import { computed, onMounted, ref, type Component } from 'vue';
import { useRouter } from 'vue-router';
import {
  FileText, CheckCircle2, Clock, PenLine, Pin, MessageSquare, ShieldAlert,
  Plus, Eye, ArrowRight, ExternalLink, Inbox, Newspaper, Globe, Monitor,
  MapPin, LayoutGrid, AppWindow, HardDrive, Image as ImageIcon, Music, Send, Save
} from '@lucide/vue';
import { api, type CommentAdminItem, type PostSummary } from '../lib/api';
import { formatDate, formatDateTime, formatBytes, postStatusMeta } from '../lib/format';
import { toast } from '../lib/toast';

const router = useRouter();

interface SourceRow {
  name: string;
  views: number;
  count?: number;
}

const loading = ref(true);
const posts = ref<PostSummary[]>([]);
const comments = ref<CommentAdminItem[]>([]);
const trend = ref<Array<{ date: string; views: number; likes: number }>>([]);
const sources = ref<{
  referrers: SourceRow[];
  devices: SourceRow[];
  countries: SourceRow[];
  platforms: SourceRow[];
  vendors: SourceRow[];
}>({ referrers: [], devices: [], countries: [], platforms: [], vendors: [] });
const sourceTotals = ref({ ref: 0, dev: 0, country: 0, platform: 0, vendor: 0 });
const site = ref({
  mediaCount: 0,
  mediaSize: 0,
  musicCount: 0,
  subsTotal: 0,
  subsActive: 0,
  backupCount: 0,
  backupLatest: 0
});

/* ---------- 统计卡 ---------- */
const stats = computed<Array<{ label: string; value: number; icon: Component; tone?: string }>>(() => {
  const count = { published: 0, scheduled: 0, draft: 0, pinned: 0 };
  for (const post of posts.value) {
    const status = (post.status ?? 'published') as 'published' | 'scheduled' | 'draft';
    if (status in count) count[status] += 1;
    if (post.pinned) count.pinned += 1;
  }
  const pending = comments.value.filter((c) => (c.status || 'approved') === 'pending').length;
  return [
    { label: '总文章', value: posts.value.length, icon: FileText },
    { label: '已发布', value: count.published, icon: CheckCircle2 },
    { label: '定时发布', value: count.scheduled, icon: Clock },
    { label: '草稿', value: count.draft, icon: PenLine },
    { label: '置顶', value: count.pinned, icon: Pin },
    { label: '评论总数', value: comments.value.length, icon: MessageSquare },
    { label: '待审评论', value: pending, icon: ShieldAlert, tone: pending > 0 ? 'text-danger' : '' }
  ];
});

/* ---------- 趋势 ---------- */
function dayKey(value: string | number | null | undefined): string {
  if (!value) return '';
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

const commentByDay = computed(() => {
  const map = new Map<string, number>();
  for (const comment of comments.value) {
    const key = dayKey(comment.date);
    if (key) map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
});

const viewDays = computed(() => trend.value.map((d) => ({ date: d.date, value: Number(d.views) || 0 })));
const commentDays = computed(() => {
  if (trend.value.length) {
    return trend.value.map((d) => ({ date: d.date, value: commentByDay.value.get(d.date) ?? 0 }));
  }
  return [...commentByDay.value.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-30)
    .map(([date, value]) => ({ date, value }));
});
const maxViews = computed(() => Math.max(1, ...viewDays.value.map((d) => d.value)));
const maxComments = computed(() => Math.max(1, ...commentDays.value.map((d) => d.value)));
const totalViews = computed(() => viewDays.value.reduce((n, d) => n + d.value, 0));
const totalCommentDays = computed(() => commentDays.value.reduce((n, d) => n + d.value, 0));

function pct(value: number, total: number): string {
  return total > 0 ? `${Math.round((value / total) * 100)}%` : '0%';
}

/* ---------- 来源分组 ---------- */
const sourceGroups = computed(() => [
  { key: 'referrers', label: '访问来源', icon: Globe, rows: sources.value.referrers.slice(0, 5), total: sourceTotals.value.ref },
  { key: 'countries', label: '国家地区', icon: MapPin, rows: sources.value.countries.slice(0, 5), total: sourceTotals.value.country },
  { key: 'devices', label: '设备', icon: Monitor, rows: sources.value.devices.slice(0, 5), total: sourceTotals.value.dev },
  { key: 'platforms', label: '平台', icon: LayoutGrid, rows: sources.value.platforms.slice(0, 5), total: sourceTotals.value.platform },
  { key: 'vendors', label: '浏览器', icon: AppWindow, rows: sources.value.vendors.slice(0, 5), total: sourceTotals.value.vendor }
]);

/* ---------- 站点资源 ---------- */
const resources = computed(() => [
  { label: '媒体文件', value: site.value.mediaCount, sub: `${formatBytes(site.value.mediaSize)} 已占用`, icon: ImageIcon },
  { label: '音乐', value: site.value.musicCount, sub: '曲目', icon: Music },
  { label: '订阅者', value: site.value.subsTotal, sub: `活跃 ${site.value.subsActive} 人`, icon: Send },
  {
    label: '备份',
    value: site.value.backupCount,
    sub: site.value.backupLatest ? `最新 ${formatDateTime(site.value.backupLatest)}` : '尚未备份',
    icon: Save
  }
]);

/* ---------- 最新动态 ---------- */
const recentPosts = computed(() =>
  posts.value
    .slice()
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
    .slice(0, 5)
);
const recentComments = computed(() => comments.value.slice(0, 5));

/* ---------- 数据加载 ---------- */
async function load(): Promise<void> {
  loading.value = true;
  const failed: string[] = [];
  const [p, c, t, s, m, mu, sub, b] = await Promise.allSettled([
    api.listPosts({ all: true }),
    api.listComments('all'),
    api.statsTrend(),
    api.statsSources(),
    api.listMedia(),
    api.listMusic(),
    api.listSubscribers(),
    api.listBackups()
  ]);

  if (p.status === 'fulfilled') posts.value = p.value.posts ?? [];
  else failed.push('文章');
  if (c.status === 'fulfilled') comments.value = c.value.comments ?? [];
  else failed.push('评论');
  if (t.status === 'fulfilled') trend.value = t.value.trend ?? [];
  else failed.push('趋势');
  if (s.status === 'fulfilled') {
    sources.value = {
      referrers: s.value.referrers ?? [],
      devices: s.value.devices ?? [],
      countries: s.value.countries ?? [],
      platforms: s.value.platforms ?? [],
      vendors: s.value.vendors ?? []
    };
    sourceTotals.value = {
      ref: s.value.refTotal ?? 0,
      dev: s.value.devTotal ?? 0,
      country: s.value.countryTotal ?? 0,
      platform: s.value.platformTotal ?? 0,
      vendor: s.value.vendorTotal ?? 0
    };
  } else failed.push('来源');
  if (m.status === 'fulfilled') {
    const media = m.value.media ?? [];
    site.value.mediaCount = media.length;
    site.value.mediaSize = media.reduce((n, item) => n + (Number(item.size) || 0), 0);
  } else failed.push('媒体');
  if (mu.status === 'fulfilled') site.value.musicCount = mu.value.music?.length ?? 0;
  else failed.push('音乐');
  if (sub.status === 'fulfilled') {
    site.value.subsTotal = sub.value.counts?.total ?? 0;
    site.value.subsActive = sub.value.counts?.active ?? 0;
  } else failed.push('订阅者');
  if (b.status === 'fulfilled') {
    const backups = b.value.backups ?? [];
    site.value.backupCount = backups.length;
    site.value.backupLatest = backups[0]?.createdAt ?? 0;
  } else failed.push('备份');

  if (failed.length) toast.error(`部分数据加载失败：${failed.join('、')}`);
  loading.value = false;
}

onMounted(load);
</script>

<template>
  <!-- 加载骨架：整页统一占位，避免个别卡片单独转圈 -->
  <div v-if="loading" class="space-y-5">
    <div class="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
      <div v-for="i in 7" :key="i" class="card p-4 h-[84px] shimmer" />
    </div>
    <div class="grid gap-5 lg:grid-cols-2">
      <div class="card h-56 shimmer" />
      <div class="card h-56 shimmer" />
    </div>
    <div class="card h-52 shimmer" />
    <div class="card h-44 shimmer" />
    <div class="grid gap-5 lg:grid-cols-2">
      <div class="card h-64 shimmer" />
      <div class="card h-64 shimmer" />
    </div>
  </div>

  <div v-else class="space-y-5">
    <!-- 说明 + 快捷操作 -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-[13px] text-ink-muted">全站数据与最新动态，一眼看全。</p>
      <div class="flex gap-2">
        <button class="btn btn-secondary" @click="router.push('/stats')">
          <Eye :size="16" />
          查看统计
        </button>
        <button class="btn btn-primary" @click="router.push({ name: 'post-new' })">
          <Plus :size="16" />
          写文章
        </button>
      </div>
    </div>

    <!-- 核心指标 -->
    <div class="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
      <div v-for="s in stats" :key="s.label" class="card p-4">
        <div class="flex items-center gap-1.5 text-[12.5px] text-ink-muted mb-1">
          <component :is="s.icon" :size="13" />
          <span class="truncate">{{ s.label }}</span>
        </div>
        <div class="text-[24px] font-semibold tabular-nums" :class="s.tone">{{ s.value }}</div>
      </div>
    </div>

    <!-- 趋势 -->
    <section class="grid gap-5 lg:grid-cols-2">
      <div class="card p-5">
        <div class="flex items-center justify-between mb-4">
          <h2 class="flex items-center gap-1.5 text-[15px] font-semibold">
            <Eye :size="15" class="text-accent" />
            近 30 天访问趋势
          </h2>
          <span class="text-[12px] text-ink-muted tabular-nums">共 {{ totalViews.toLocaleString() }} 次</span>
        </div>
        <div v-if="viewDays.length" class="flex items-end gap-[3px] h-36">
          <div
            v-for="d in viewDays"
            :key="d.date"
            class="flex-1 rounded-t-[3px] bg-accent/70 hover:bg-accent transition-colors min-h-[2px]"
            :style="{ height: `${Math.max(2, (d.value / maxViews) * 100)}%` }"
            :title="`${d.date}：${d.value} 次浏览`"
          />
        </div>
        <div v-else class="h-36 grid place-items-center text-[13px] text-ink-muted">暂无访问数据</div>
        <div v-if="viewDays.length" class="flex justify-between text-[11px] text-ink-muted mt-2">
          <span>{{ viewDays[0].date }}</span>
          <span>{{ viewDays[viewDays.length - 1].date }}</span>
        </div>
      </div>

      <div class="card p-5">
        <div class="flex items-center justify-between mb-4">
          <h2 class="flex items-center gap-1.5 text-[15px] font-semibold">
            <MessageSquare :size="15" class="text-accent" />
            近 30 天评论趋势
          </h2>
          <span class="text-[12px] text-ink-muted tabular-nums">共 {{ totalCommentDays.toLocaleString() }} 条</span>
        </div>
        <div v-if="commentDays.length" class="flex items-end gap-[3px] h-36">
          <div
            v-for="d in commentDays"
            :key="d.date"
            class="flex-1 rounded-t-[3px] bg-accent/70 hover:bg-accent transition-colors min-h-[2px]"
            :style="{ height: `${Math.max(2, (d.value / maxComments) * 100)}%` }"
            :title="`${d.date}：${d.value} 条评论`"
          />
        </div>
        <div v-else class="h-36 grid place-items-center text-[13px] text-ink-muted">暂无评论数据</div>
        <div v-if="commentDays.length" class="flex justify-between text-[11px] text-ink-muted mt-2">
          <span>{{ commentDays[0].date }}</span>
          <span>{{ commentDays[commentDays.length - 1].date }}</span>
        </div>
      </div>
    </section>

    <!-- 访问来源 -->
    <section class="card p-5">
      <div class="flex items-center justify-between mb-4">
        <h2 class="flex items-center gap-1.5 text-[15px] font-semibold">
          <Globe :size="15" class="text-accent" />
          访问来源概览
        </h2>
        <button class="btn btn-ghost btn-sm" @click="router.push('/stats')">
          全部统计
          <ArrowRight :size="14" />
        </button>
      </div>
      <div class="grid gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <div v-for="g in sourceGroups" :key="g.key">
          <div class="flex items-center gap-1.5 text-[12.5px] font-medium text-ink-soft mb-2">
            <component :is="g.icon" :size="13" class="text-ink-muted" />
            <span>{{ g.label }}</span>
            <span class="ml-auto text-[11px] text-ink-muted tabular-nums">{{ g.total }}</span>
          </div>
          <div v-if="g.rows.length === 0" class="text-[12px] text-ink-muted py-2">暂无数据</div>
          <div v-else class="space-y-2">
            <div v-for="row in g.rows" :key="row.name">
              <div class="flex items-center justify-between gap-2 text-[12px]">
                <span class="truncate text-ink-soft" :title="row.name">{{ row.name || '直接访问' }}</span>
                <span class="shrink-0 text-ink-muted tabular-nums">{{ row.views }}</span>
              </div>
              <div class="mt-1 h-1 rounded-full bg-surface-3 overflow-hidden">
                <div class="h-full bg-accent/60" :style="{ width: pct(row.views, g.total) }" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 站点资源 -->
    <section class="card p-5">
      <h2 class="flex items-center gap-1.5 text-[15px] font-semibold mb-4">
        <HardDrive :size="15" class="text-accent" />
        站点资源
      </h2>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div v-for="item in resources" :key="item.label" class="rounded-xl bg-surface-2 p-4">
          <div class="flex items-center gap-1.5 text-[12.5px] text-ink-muted mb-1">
            <component :is="item.icon" :size="13" />
            <span class="truncate">{{ item.label }}</span>
          </div>
          <div class="text-[22px] font-semibold tabular-nums">{{ item.value }}</div>
          <div class="text-[12px] text-ink-muted mt-0.5 truncate">{{ item.sub }}</div>
        </div>
      </div>
    </section>

    <!-- 最新文章 / 最新评论 -->
    <section class="grid gap-5 lg:grid-cols-2">
      <div class="card p-5">
        <div class="flex items-center justify-between mb-3">
          <h2 class="flex items-center gap-1.5 text-[15px] font-semibold">
            <Newspaper :size="15" class="text-accent" />
            最新文章
          </h2>
          <button class="btn btn-ghost btn-sm" @click="router.push('/posts')">
            全部
            <ArrowRight :size="14" />
          </button>
        </div>

        <div v-if="recentPosts.length === 0" class="py-10 flex flex-col items-center text-center">
          <span class="grid place-items-center size-11 rounded-2xl bg-surface-2 text-ink-muted mb-3">
            <Inbox :size="20" />
          </span>
          <p class="text-[13px] text-ink-muted">还没有文章</p>
          <button class="btn btn-primary btn-sm mt-4" @click="router.push({ name: 'post-new' })">
            <Plus :size="14" />
            写第一篇
          </button>
        </div>

        <div v-else class="space-y-0.5">
          <div
            v-for="post in recentPosts"
            :key="post.id"
            class="flex items-center gap-3 px-2 py-2.5 rounded-lg hover:bg-surface-2 transition-colors group"
          >
            <button class="flex-1 min-w-0 text-left" @click="router.push({ name: 'post-edit', params: { id: post.id } })">
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-[13.5px] font-medium truncate">{{ post.title || '未命名' }}</span>
                <span class="badge shrink-0" :class="postStatusMeta[post.status]?.badge ?? 'badge-neutral'">
                  {{ postStatusMeta[post.status]?.label ?? post.status }}
                </span>
                <span v-if="post.pinned" class="badge badge-info shrink-0">置顶</span>
              </div>
              <div class="text-[12px] text-ink-muted mt-0.5 truncate">
                {{ formatDate(post.date) }}
                <span v-if="post.category">· {{ post.category }}</span>
              </div>
            </button>
            <a
              v-if="post.status === 'published'"
              class="btn btn-ghost btn-icon btn-sm shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
              :href="`/posts/${encodeURIComponent(post.id)}/`"
              target="_blank"
              rel="noopener"
              title="查看"
              @click.stop
            >
              <ExternalLink :size="15" />
            </a>
          </div>
        </div>
      </div>

      <div class="card p-5">
        <div class="flex items-center justify-between mb-3">
          <h2 class="flex items-center gap-1.5 text-[15px] font-semibold">
            <MessageSquare :size="15" class="text-accent" />
            最新评论
          </h2>
          <button class="btn btn-ghost btn-sm" @click="router.push('/comments')">
            全部
            <ArrowRight :size="14" />
          </button>
        </div>

        <div v-if="recentComments.length === 0" class="py-10 flex flex-col items-center text-center">
          <span class="grid place-items-center size-11 rounded-2xl bg-surface-2 text-ink-muted mb-3">
            <Inbox :size="20" />
          </span>
          <p class="text-[13px] text-ink-muted">还没有评论</p>
          <p class="text-[12px] text-ink-muted mt-1">访客的留言会出现在这里。</p>
        </div>

        <div v-else class="space-y-0.5">
          <button
            v-for="comment in recentComments"
            :key="comment.id"
            class="w-full text-left flex items-start gap-3 px-2 py-2.5 rounded-lg hover:bg-surface-2 transition-colors"
            @click="router.push('/comments')"
          >
            <span class="grid place-items-center size-8 shrink-0 rounded-full bg-accent-soft text-accent text-[13px] font-semibold">
              {{ (comment.author || '匿').slice(0, 1) }}
            </span>
            <span class="flex-1 min-w-0">
              <span class="flex items-center gap-2 min-w-0">
                <span class="text-[13.5px] font-medium truncate">{{ comment.author || '匿名' }}</span>
                <span v-if="(comment.status || 'approved') === 'pending'" class="badge badge-warning shrink-0">待审</span>
              </span>
              <span class="block text-[12.5px] text-ink-muted mt-0.5 line-clamp-2">{{ comment.content }}</span>
              <span class="block text-[11.5px] text-ink-muted mt-1 truncate">
                <template v-if="comment.post_title">《{{ comment.post_title }}》 · </template>
                {{ formatDate(comment.date) }}
              </span>
            </span>
          </button>
        </div>
      </div>
    </section>
  </div>
</template>