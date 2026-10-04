<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { TrendingUp, Eye, Heart } from '@lucide/vue';
import { api, ApiError } from '../lib/api';
import { toast } from '../lib/toast';

interface Row { name: string; views: number; count?: number }

const trend = ref<Array<{ date: string; views: number; likes: number }>>([]);
const sources = ref<Record<string, Row[]>>({});
const totals = ref({ views: 0, likes: 0, referrers: 0, countries: 0 });
const loading = ref(true);

const maxViews = computed(() => Math.max(1, ...trend.value.map((d) => d.views)));

const tabs = computed(() =>
  (['referrers', 'devices', 'countries', 'platforms'] as const).map((key) => ({
    key,
    label: { referrers: '来源', devices: '设备', countries: '国家', platforms: '平台' }[key],
    rows: (sources.value[key] ?? []).slice(0, 8)
  }))
);
const activeTab = ref<'referrers' | 'devices' | 'countries' | 'platforms'>('referrers');
const activeRows = computed(() => tabs.value.find((t) => t.key === activeTab.value)?.rows ?? []);

onMounted(async () => {
  try {
    const [t, s] = await Promise.all([api.statsTrend(), api.statsSources()]);
    trend.value = t.trend ?? [];
    sources.value = { referrers: s.referrers, devices: s.devices, countries: s.countries, platforms: s.platforms };
    totals.value = {
      views: s.refTotal + s.devTotal > 0 ? trend.value.reduce((n, d) => n + d.views, 0) : trend.value.reduce((n, d) => n + d.views, 0),
      likes: trend.value.reduce((n, d) => n + d.likes, 0),
      referrers: s.referrers.length,
      countries: s.countries.length
    };
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '加载统计失败');
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div v-if="loading" class="card h-64 shimmer" />
  <div v-else class="space-y-6">
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div class="card p-4">
        <div class="flex items-center gap-1.5 text-[12.5px] text-ink-muted mb-1"><Eye :size="13" /> 总浏览</div>
        <div class="text-[24px] font-semibold tabular-nums">{{ totals.views.toLocaleString() }}</div>
      </div>
      <div class="card p-4">
        <div class="flex items-center gap-1.5 text-[12.5px] text-ink-muted mb-1"><Heart :size="13" /> 总点赞</div>
        <div class="text-[24px] font-semibold tabular-nums">{{ totals.likes.toLocaleString() }}</div>
      </div>
      <div class="card p-4">
        <div class="flex items-center gap-1.5 text-[12.5px] text-ink-muted mb-1"><TrendingUp :size="13" /> 来源数</div>
        <div class="text-[24px] font-semibold tabular-nums">{{ totals.referrers }}</div>
      </div>
      <div class="card p-4">
        <div class="flex items-center gap-1.5 text-[12.5px] text-ink-muted mb-1">覆盖国家</div>
        <div class="text-[24px] font-semibold tabular-nums">{{ totals.countries }}</div>
      </div>
    </div>

    <section class="card p-5">
      <h2 class="text-[15px] font-semibold mb-4">近 30 天浏览趋势</h2>
      <div class="flex items-end gap-[3px] h-40">
        <div
          v-for="d in trend"
          :key="d.date"
          class="flex-1 rounded-t-[3px] bg-accent/70 hover:bg-accent transition-colors min-h-[2px]"
          :style="{ height: `${Math.max(2, (d.views / maxViews) * 100)}%` }"
          :title="`${d.date}：${d.views} 次浏览`"
        />
      </div>
      <div class="flex justify-between text-[11px] text-ink-muted mt-2">
        <span>{{ trend[0]?.date }}</span><span>{{ trend[trend.length - 1]?.date }}</span>
      </div>
    </section>

    <section class="card p-5">
      <div class="flex gap-1 p-1 rounded-xl bg-surface-2 mb-4 w-fit">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="h-7 px-3 rounded-[8px] text-[13px] font-medium transition-all"
          :class="activeTab === t.key ? 'bg-surface text-ink shadow-xs' : 'text-ink-muted hover:text-ink'"
          @click="activeTab = t.key"
        >{{ t.label }}</button>
      </div>
      <div v-if="activeRows.length === 0" class="text-[13px] text-ink-muted py-6 text-center">暂无数据</div>
      <div v-else class="space-y-2">
        <div v-for="row in activeRows" :key="row.name" class="flex items-center gap-3">
          <span class="text-[13px] w-32 truncate" :title="row.name">{{ row.name || '直接访问' }}</span>
          <div class="flex-1 h-1.5 rounded-full bg-surface-3 overflow-hidden">
            <div class="h-full bg-accent/70" :style="{ width: `${(row.views / Math.max(1, activeRows[0].views)) * 100}%` }" />
          </div>
          <span class="text-[12px] text-ink-muted tabular-nums w-14 text-right">{{ row.views.toLocaleString() }}</span>
        </div>
      </div>
    </section>
  </div>
</template>