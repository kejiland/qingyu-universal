<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type Component } from 'vue';
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

/** 统一时间轴：日期 + 访问数 + 评论数（与上游 lineChart 的 days 结构一致） */
const chartDays = computed(() => {
  if (trend.value.length) {
    return trend.value.map((d) => ({
      date: d.date,
      views: Number(d.views) || 0,
      comments: commentByDay.value.get(d.date) ?? 0
    }));
  }
  return [...commentByDay.value.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-30)
    .map(([date, comments]) => ({ date, views: 0, comments }));
});

const totalViews = computed(() => chartDays.value.reduce((n, d) => n + d.views, 0));
const totalCommentDays = computed(() => chartDays.value.reduce((n, d) => n + d.comments, 0));

function pct(value: number, total: number): string {
  return total > 0 ? `${Math.round((value / total) * 100)}%` : '0%';
}

/* ---------- 趋势折线图（SVG 手绘：网格 + 刻度 + 悬停浮层 + 点击固定） ---------- */
type Metric = 'views' | 'comments';

const CHART_W = 520;
const CHART_H = 200;
const CHART_PAD = 30;
const CHART_PAD_TOP = 16;

interface ChartGeom {
  has: boolean;
  pts: Array<[number, number]>;
  line: string;
  area: string;
  max: number;
  gridY: number[];
  tickIdx: number[];
}

const EMPTY_GEOM: ChartGeom = { has: false, pts: [], line: '', area: '', max: 0, gridY: [], tickIdx: [] };

/** Catmull-Rom 平滑曲线，与上游 smoothLinePath 完全一致 */
function smoothPath(pts: Array<[number, number]>): string {
  if (!pts.length) return '';
  if (pts.length < 3) {
    return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  }
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)},${c2x.toFixed(1)} ${c2y.toFixed(1)},${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

function buildChart(metric: Metric): ChartGeom {
  const days = chartDays.value;
  const n = days.length;
  if (!n) return EMPTY_GEOM;
  const values = days.map((d) => d[metric]);
  const max = Math.max(1, ...values);
  const plotH = CHART_H - CHART_PAD - CHART_PAD_TOP;
  const step = (CHART_W - CHART_PAD * 2) / Math.max(1, n - 1);
  const pts = values.map(
    (v, i) => [CHART_PAD + i * step, CHART_H - CHART_PAD - (v / max) * plotH] as [number, number]
  );
  const line = smoothPath(pts);
  const baseline = CHART_H - CHART_PAD;
  const area = `${line} L${pts[n - 1][0].toFixed(1)} ${baseline} L${pts[0][0].toFixed(1)} ${baseline} Z`;
  const gridY = [0, 0.25, 0.5, 0.75, 1].map((f) => CHART_PAD_TOP + plotH * f);
  const tickEvery = Math.max(1, Math.ceil(n / 6));
  const tickIdx: number[] = [];
  for (let k = 0; k < n; k += tickEvery) tickIdx.push(k);
  if (tickIdx[tickIdx.length - 1] !== n - 1) tickIdx.push(n - 1);
  return { has: true, pts, line, area, max, gridY, tickIdx };
}

const viewsChart = computed(() => buildChart('views'));
const commentsChart = computed(() => buildChart('comments'));

const charts = computed(() => [
  {
    metric: 'views' as Metric,
    title: '近 30 天访问趋势',
    unit: '次',
    icon: Eye,
    total: totalViews.value,
    geom: viewsChart.value
  },
  {
    metric: 'comments' as Metric,
    title: '近 30 天评论趋势',
    unit: '条',
    icon: MessageSquare,
    total: totalCommentDays.value,
    geom: commentsChart.value
  }
]);

/** 当前浮层：同时最多一张；pinned 为真表示已点击固定 */
const tip = ref<{ metric: Metric; index: number; pinned: boolean } | null>(null);

function chartGeom(metric: Metric): ChartGeom {
  return metric === 'views' ? viewsChart.value : commentsChart.value;
}

function activeIndex(metric: Metric): number {
  return tip.value && tip.value.metric === metric ? tip.value.index : -1;
}

/** 把指针横坐标换算成最近的数据点下标（与上游 nearest 一致） */
function nearest(metric: Metric, e: PointerEvent | MouseEvent): number {
  const geom = chartGeom(metric);
  if (!geom.has) return 0;
  const box = e.currentTarget as HTMLElement;
  const rect = box.getBoundingClientRect();
  const n = geom.pts.length;
  const step = (CHART_W - CHART_PAD * 2) / Math.max(1, n - 1);
  const vx = rect.width > 0 ? ((e.clientX - rect.left) / rect.width) * CHART_W : 0;
  return Math.max(0, Math.min(n - 1, Math.round((vx - CHART_PAD) / step)));
}

function onMove(metric: Metric, e: PointerEvent): void {
  const geom = chartGeom(metric);
  if (!geom.has) return;
  // 已固定的浮层不随悬停移动
  if (tip.value && tip.value.metric === metric && tip.value.pinned) return;
  tip.value = { metric, index: nearest(metric, e), pinned: false };
}

function onLeave(metric: Metric): void {
  // 未固定的悬停浮层，离开区域即隐藏；已固定的保留
  if (tip.value && tip.value.metric === metric && !tip.value.pinned) tip.value = null;
}

function onChartClick(metric: Metric, e: MouseEvent): void {
  const geom = chartGeom(metric);
  if (!geom.has) return;
  const index = nearest(metric, e);
  // 再次点击同一点 → 取消固定
  if (tip.value && tip.value.metric === metric && tip.value.pinned && tip.value.index === index) {
    tip.value = null;
    return;
  }
  tip.value = { metric, index, pinned: true };
}

/** 点击图表外部时取消固定（与上游 document 监听一致） */
function onDocClick(e: MouseEvent): void {
  if (!tip.value || !tip.value.pinned) return;
  const target = e.target as Element | null;
  if (target && typeof target.closest === 'function' && target.closest('[data-chart-box]')) return;
  tip.value = null;
}

function tipStyle(geom: ChartGeom, index: number): Record<string, string> {
  const p = geom.pts[index];
  const left = Math.max(9, Math.min(91, (p[0] / CHART_W) * 100));
  const top = (p[1] / CHART_H) * 100;
  const nearTop = p[1] < CHART_H * 0.32;
  return {
    left: `${left.toFixed(2)}%`,
    top: `${top.toFixed(2)}%`,
    transform: nearTop ? 'translate(-50%, 6px)' : 'translate(-50%, -100%)'
  };
}

function tickLabel(index: number): string {
  const date = chartDays.value[index]?.date ?? '';
  return date.slice(5).replace('-', '/');
}

/* ---------- 来源分组 ---------- */
const sourceGroups = computed(() => [
  { key: 'referrers', label: '访问来源', icon: Globe, rows: sources.value.referrers.slice(0, 5), total: sourceTotals.value.ref },
  { key: 'countries', label: '国家地区', icon: MapPin, rows: sources.value.countries.slice(0, 5), total: sourceTotals.value.country },
  { key: 'devices', label: '设备', icon: Monitor, rows: sources.value.devices.slice(0, 5), total: sourceTotals.value.dev },
  { key: 'platforms', label: '平台', icon: LayoutGrid, rows: sources.value.platforms.slice(0, 5), total: sourceTotals.value.platform },
  { key: 'vendors', label: '浏览器', icon: AppWindow, rows: sources.value.vendors.slice(0, 5), total: sourceTotals.value.vendor }
]);

/** 两位国家码 → 国旗 emoji + 代码（如 CN → 🇨🇳 CN），与上游 countryLabel 一致 */
function countryLabel(code: string): string {
  const c = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '未知';
  try {
    return (
      String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65) +
      String.fromCodePoint(0x1f1e6 + c.charCodeAt(1) - 65) +
      ' ' +
      c
    );
  } catch {
    return c;
  }
}

function rowLabel(groupKey: string, name: string): string {
  if (groupKey === 'countries') return countryLabel(name);
  return name || '直接访问';
}

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
const recentComments = computed(() => comments.value.slice(0, 10));

/* ---------- 最新评论自动滚动（内容超出容器时匀速上滚循环） ---------- */
const feedRef = ref<HTMLElement | null>(null);
let feedTimer: number | undefined;

function stopFeedScroll(): void {
  if (feedTimer) {
    window.clearInterval(feedTimer);
    feedTimer = undefined;
  }
}

function startFeedScroll(): void {
  stopFeedScroll();
  const el = feedRef.value;
  if (!el) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  if (el.scrollHeight <= el.clientHeight + 2) return;
  feedTimer = window.setInterval(() => {
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) el.scrollTop = 0;
    else el.scrollTop += 0.6;
  }, 40);
}

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
  await nextTick();
  startFeedScroll();
}

onMounted(() => {
  document.addEventListener('click', onDocClick);
  void load();
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  stopFeedScroll();
});
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
    <!-- 快捷操作（页面副标题由外壳统一渲染，这里不再重复） -->
    <div class="flex flex-wrap items-center justify-end gap-3">
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

    <!-- 趋势（折线图：悬停预览 / 点击固定 / 再点取消） -->
    <section class="grid gap-5 lg:grid-cols-2">
      <div v-for="c in charts" :key="c.metric" class="card p-5">
        <div class="flex items-center justify-between mb-4">
          <h2 class="flex items-center gap-1.5 text-[15px] font-semibold">
            <component :is="c.icon" :size="15" class="text-accent" />
            {{ c.title }}
          </h2>
          <span class="text-[12px] text-ink-muted tabular-nums">共 {{ c.total.toLocaleString() }} {{ c.unit }}</span>
        </div>

        <template v-if="c.geom.has">
          <div
            class="chart-box"
            data-chart-box
            @pointermove="onMove(c.metric, $event)"
            @pointerleave="onLeave(c.metric)"
            @click="onChartClick(c.metric, $event)"
          >
            <svg class="chart-svg" :viewBox="`0 0 ${CHART_W} ${CHART_H}`" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <linearGradient :id="`chartGrad-${c.metric}`" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.32" />
                  <stop offset="70%" stop-color="var(--accent)" stop-opacity="0.06" />
                  <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
                </linearGradient>
              </defs>
              <line
                v-for="(y, gi) in c.geom.gridY"
                :key="`grid-${gi}`"
                class="chart-grid"
                :x1="CHART_PAD"
                :y1="y"
                :x2="CHART_W - CHART_PAD"
                :y2="y"
              />
              <line
                class="chart-axis"
                :x1="CHART_PAD"
                :y1="CHART_H - CHART_PAD"
                :x2="CHART_W - CHART_PAD"
                :y2="CHART_H - CHART_PAD"
              />
              <text class="chart-ylab" :x="CHART_PAD - 7" :y="CHART_PAD_TOP + 4" text-anchor="end">{{ c.geom.max }}</text>
              <text class="chart-ylab" :x="CHART_PAD - 7" :y="CHART_H - CHART_PAD + 3" text-anchor="end">0</text>
              <path class="chart-area" :d="c.geom.area" :fill="`url(#chartGrad-${c.metric})`" />
              <path class="chart-line" :d="c.geom.line" />
              <line
                v-if="activeIndex(c.metric) >= 0"
                class="chart-guide"
                :x1="c.geom.pts[activeIndex(c.metric)][0]"
                :y1="CHART_PAD_TOP"
                :x2="c.geom.pts[activeIndex(c.metric)][0]"
                :y2="CHART_H - CHART_PAD"
              />
              <circle
                v-for="(p, pi) in c.geom.pts"
                :key="`dot-${pi}`"
                class="chart-dot"
                :class="{ on: activeIndex(c.metric) === pi }"
                :cx="p[0]"
                :cy="p[1]"
                :r="activeIndex(c.metric) === pi ? 4.4 : 2.6"
              />
            </svg>

            <div class="chart-axis-row">
              <span
                v-for="ti in c.geom.tickIdx"
                :key="`tick-${ti}`"
                class="chart-tick"
                :style="{ left: `${((c.geom.pts[ti][0] / CHART_W) * 100).toFixed(2)}%` }"
              >
                {{ tickLabel(ti) }}
              </span>
            </div>

            <div
              v-if="tip && tip.metric === c.metric"
              class="chart-tip shadow-lg"
              :style="tipStyle(c.geom, tip.index)"
            >
              <b>{{ tickLabel(tip.index) }}</b>
              <span class="chart-tip-v">访问 {{ chartDays[tip.index]?.views ?? 0 }}</span>
              <span class="chart-tip-c">评论 {{ chartDays[tip.index]?.comments ?? 0 }}</span>
            </div>
          </div>
        </template>
        <div v-else class="h-36 grid place-items-center text-[13px] text-ink-muted">
          暂无{{ c.metric === 'views' ? '访问' : '评论' }}数据
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
                <span class="truncate text-ink-soft" :title="rowLabel(g.key, row.name)">{{ rowLabel(g.key, row.name) }}</span>
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

        <div
          v-else
          ref="feedRef"
          class="comment-feed"
          @pointerenter="stopFeedScroll"
          @pointerleave="startFeedScroll"
        >
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

<style scoped>
/* ---------- 趋势折线图 ---------- */
.chart-box {
  position: relative;
  cursor: crosshair;
  touch-action: pan-y;
}
.chart-svg {
  width: 100%;
  height: 150px;
  display: block;
}
.chart-grid {
  stroke: var(--border);
  stroke-width: 1;
  stroke-dasharray: 3 4;
}
.chart-axis {
  stroke: var(--border-strong);
  stroke-width: 1;
}
.chart-guide {
  stroke: var(--accent);
  stroke-width: 1;
  opacity: 0.5;
}
.chart-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.chart-dot {
  fill: var(--accent);
  opacity: 0.55;
  transition: opacity 0.12s ease;
}
.chart-dot.on {
  opacity: 1;
}
.chart-ylab {
  fill: var(--ink-muted);
  font-size: 11px;
}
.chart-axis-row {
  position: relative;
  height: 14px;
  margin-top: 4px;
}
.chart-tick {
  position: absolute;
  transform: translateX(-50%);
  font-size: 11px;
  color: var(--ink-muted);
  white-space: nowrap;
}
.chart-tip {
  position: absolute;
  z-index: 10;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--ink);
  font-size: 12px;
  line-height: 1.35;
  white-space: nowrap;
}
.chart-tip b {
  font-size: 12.5px;
  font-weight: 600;
}
.chart-tip-v,
.chart-tip-c {
  color: var(--ink-muted);
  font-variant-numeric: tabular-nums;
}

/* ---------- 最新评论：内容过长时自动滚动 ---------- */
.comment-feed {
  max-height: 330px;
  overflow-y: auto;
  scrollbar-width: thin;
  overscroll-behavior: contain;
}
</style>
