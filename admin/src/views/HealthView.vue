<script setup lang="ts">
import { computed, onMounted, ref, type Component } from 'vue';
import { Database, Zap, Image, HardDrive, Sparkles, Mail, RefreshCw, Loader2, CircleCheck, CircleAlert, Inbox } from '@lucide/vue';
import { api, ApiError, type HealthItem } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { toast } from '../lib/toast';

interface Meta {
  label: string;
  desc: string;
  icon: Component;
}

/** 检查项的中文名与说明（与原版 i18n 文案对齐，但按通用版改写）。 */
const META: Record<string, Meta> = {
  db: { label: '数据库', desc: '文章、评论等数据能否正常读写', icon: Database },
  kv: { label: '缓存存储', desc: '限流计数、点赞去重等小对象（KV / 数据库表 / Redis）', icon: Zap },
  r2media: { label: '媒体存储', desc: '图片等上传文件的存放（本地磁盘 / S3 兼容）', icon: Image },
  r2backup: { label: '备份存储', desc: '备份文件的存放位置', icon: HardDrive },
  ai: { label: 'AI 服务', desc: 'AI 摘要与写作助手的模型绑定', icon: Sparkles },
  mail: { label: '邮件发送', desc: '订阅确认与提醒（SMTP 或 Resend）', icon: Mail }
};

/** 数据表英文名 → 中文名。 */
const TABLE_LABELS: Record<string, string> = {
  posts: '文章',
  comments: '评论',
  media: '媒体',
  music: '音乐',
  subscribers: '订阅者',
  backups: '备份',
  audit_log: '审计日志'
};

const items = ref<HealthItem[]>([]);
const checkedAt = ref(0);
const loading = ref(true);
const failed = ref(false);

const summary = computed(() => {
  const ok = items.value.filter((item) => item.ok).length;
  return { ok, bad: items.value.length - ok, total: items.value.length };
});

function metaOf(key: string): Meta {
  return META[key] ?? { label: key, desc: '', icon: CircleAlert };
}

/** 数据库那一项附带的各表记录数。 */
function countsText(item: HealthItem): string {
  const entries = Object.entries(item.counts ?? {});
  if (!entries.length) return '';
  return entries
    .map(([table, count]) => `${TABLE_LABELS[table] ?? table} ${count === null ? '—' : count}`)
    .join(' · ');
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const data = await api.adminHealth();
    items.value = data.items ?? [];
    checkedAt.value = data.checkedAt ?? 0;
    failed.value = false;
  } catch (e) {
    items.value = [];
    failed.value = true;
    toast.error(e instanceof ApiError ? e.message : '健康检查失败');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <!-- 工具条 -->
    <div class="flex flex-wrap items-center gap-3 mb-5">
      <p class="text-[13px] text-ink-muted">
        一键检查数据库、缓存、存储、AI 与邮件的可用性
        <span v-if="checkedAt" class="text-ink-muted/80">· 最近检查 {{ formatDateTime(checkedAt) }}</span>
      </p>
      <button class="btn btn-secondary ml-auto shrink-0" :disabled="loading" @click="load">
        <Loader2 v-if="loading" :size="16" class="animate-spin" />
        <RefreshCw v-else :size="16" />
        <span>{{ loading ? '检查中…' : '重新检查' }}</span>
      </button>
    </div>

    <!-- 加载骨架 -->
    <div v-if="loading" class="space-y-4">
      <div class="grid grid-cols-2 gap-3">
        <div v-for="i in 2" :key="i" class="card p-4 h-[78px] shimmer" />
      </div>
      <div class="space-y-2.5">
        <div v-for="i in 6" :key="i" class="card p-4 h-[80px] shimmer" />
      </div>
    </div>

    <!-- 失败状态 -->
    <div v-else-if="failed" class="card py-16 flex flex-col items-center text-center">
      <span class="grid place-items-center size-12 rounded-2xl bg-surface-2 text-ink-muted mb-3">
        <CircleAlert :size="22" />
      </span>
      <p class="text-sm font-medium">健康检查失败</p>
      <p class="text-[13px] text-ink-muted mt-1">服务可能正在重启，稍候再试一次。</p>
      <button class="btn btn-primary mt-5" @click="load">
        <RefreshCw :size="16" />
        重新检查
      </button>
    </div>

    <div v-else class="space-y-5">
      <!-- 结果概览 -->
      <div class="grid grid-cols-2 gap-3">
        <div class="card p-4">
          <div class="flex items-center gap-1.5 text-[12.5px] text-ink-muted mb-1">
            <CircleCheck :size="13" class="text-success" />
            正常
          </div>
          <div class="text-[24px] font-semibold tabular-nums text-success">
            {{ summary.ok }}<span class="text-[14px] font-normal text-ink-muted"> / {{ summary.total }}</span>
          </div>
        </div>
        <div class="card p-4">
          <div class="flex items-center gap-1.5 text-[12.5px] text-ink-muted mb-1">
            <CircleAlert :size="13" :class="summary.bad > 0 ? 'text-warning' : 'text-ink-muted'" />
            未配置 / 需关注
          </div>
          <div
            class="text-[24px] font-semibold tabular-nums"
            :class="summary.bad > 0 ? 'text-warning' : 'text-ink-muted'"
          >
            {{ summary.bad }}<span class="text-[14px] font-normal text-ink-muted"> / {{ summary.total }}</span>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-if="items.length === 0" class="card py-16 flex flex-col items-center text-center">
        <span class="grid place-items-center size-12 rounded-2xl bg-surface-2 text-ink-muted mb-3">
          <Inbox :size="22" />
        </span>
        <p class="text-sm font-medium">没有返回检查结果</p>
        <p class="text-[13px] text-ink-muted mt-1">点右上角「重新检查」再试一次。</p>
      </div>

      <!-- 检查项 -->
      <div v-else class="space-y-2.5">
        <article v-for="item in items" :key="item.key" class="card p-4">
          <div class="flex items-start gap-4">
            <span
              class="grid place-items-center size-10 rounded-xl shrink-0"
              :class="item.ok ? 'bg-success-soft text-success' : 'bg-surface-2 text-ink-muted'"
            >
              <component :is="metaOf(item.key).icon" :size="18" />
            </span>

            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-[14px] font-semibold">{{ metaOf(item.key).label }}</span>
                <span class="badge" :class="item.ok ? 'badge-success' : 'badge-warning'">
                  {{ item.ok ? '正常' : '未配置' }}
                </span>
              </div>
              <p class="text-[12.5px] text-ink-muted mt-1">{{ metaOf(item.key).desc }}</p>
              <p v-if="countsText(item)" class="text-[12px] text-ink-muted mt-1.5 truncate" :title="countsText(item)">
                {{ countsText(item) }}
              </p>
            </div>

          </div>
        </article>
      </div>

      <p class="hint">
        「未配置」表示该能力当前没有启用，不一定是故障——例如没接 AI 或没配邮件时，对应功能会自动关闭。
      </p>
    </div>
  </div>
</template>