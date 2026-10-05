<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { Construction } from '@lucide/vue';

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
  () => sections[route.path] ?? { title: (route.meta.title as string) ?? '页面不存在', desc: '这个管理路径不存在，或已经被移动到其他位置。' }
);
</script>

<template>
  <div class="card py-16 px-6 flex flex-col items-center text-center animate-in">
    <span class="grid place-items-center size-14 rounded-2xl bg-warning-soft text-warning mb-4">
      <Construction :size="26" />
    </span>

    <h2 class="text-[17px] font-semibold">{{ info.title }}</h2>
    <p class="text-[13.5px] text-ink-muted mt-2 max-w-[420px] leading-relaxed">{{ info.desc }}</p>

    <div class="flex items-center gap-2 mt-6">
      <RouterLink to="/posts" class="btn btn-primary">返回文章</RouterLink>
    </div>
  </div>
</template>