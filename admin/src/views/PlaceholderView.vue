<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { Construction, ExternalLink } from '@lucide/vue';

const route = useRoute();

const sections: Record<string, { title: string; desc: string }> = {
  '/comments': { title: '评论管理', desc: '审核、回复、置顶与批量处理。' },
  '/settings': { title: '站点设置', desc: '站点信息、导航、页脚、功能开关与广告位。' },
  '/subscribers': { title: '订阅者', desc: '订阅列表、分组与邮件推送。' },
  '/backups': { title: '备份', desc: '站点快照的创建、下载与恢复。' },
  '/logs': { title: '日志', desc: '操作审计与错误日志。' },
  '/stats': { title: '统计', desc: '访问趋势与来源分析。' }
};

const info = computed(
  () => sections[route.path] ?? { title: (route.meta.title as string) ?? '该模块', desc: '这个模块尚未迁移到新版界面。' }
);
</script>

<template>
  <div class="card py-16 px-6 flex flex-col items-center text-center animate-in">
    <span class="grid place-items-center size-14 rounded-2xl bg-warning-soft text-warning mb-4">
      <Construction :size="26" />
    </span>

    <h2 class="text-[17px] font-semibold">{{ info.title }}</h2>
    <p class="text-[13.5px] text-ink-muted mt-2 max-w-[420px] leading-relaxed">{{ info.desc }}</p>

    <p class="text-[13px] text-ink-soft mt-5 max-w-[440px] leading-relaxed">
      新版后台正在逐模块迁移。为避免功能中断，<strong>该模块暂时仍在旧版后台可用</strong>，
      数据完全一致。
    </p>

    <div class="flex items-center gap-2 mt-6">
      <a href="/admin-legacy" class="btn btn-primary">
        <ExternalLink :size="16" />
        前往旧版后台
      </a>
      <RouterLink to="/posts" class="btn btn-secondary">返回文章</RouterLink>
    </div>
  </div>
</template>