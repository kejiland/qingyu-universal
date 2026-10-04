<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  FileText, Image as ImageIcon, MessageSquare, Settings, Users, DatabaseBackup,
  ScrollText, LogOut, Moon, Sun, Menu, X, ExternalLink, PenLine
} from '@lucide/vue';
import { api, session } from '../../lib/api';
import { toast } from '../../lib/toast';

const route = useRoute();
const router = useRouter();

const navGroups = [
  {
    label: '内容',
    items: [
      { to: '/posts', label: '文章', icon: FileText, match: /^\/posts/ },
      { to: '/media', label: '媒体库', icon: ImageIcon, match: /^\/media/ },
      { to: '/comments', label: '评论', icon: MessageSquare, match: /^\/comments/ }
    ]
  },
  {
    label: '站点',
    items: [
      { to: '/settings', label: '设置', icon: Settings, match: /^\/settings/ },
      { to: '/subscribers', label: '订阅者', icon: Users, match: /^\/subscribers/ }
    ]
  },
  {
    label: '系统',
    items: [
      { to: '/backups', label: '备份', icon: DatabaseBackup, match: /^\/backups/ },
      { to: '/logs', label: '日志', icon: ScrollText, match: /^\/logs/ }
    ]
  }
];

const pageTitle = computed(() => (route.meta.title as string | undefined) ?? '管理后台');

/* ---------- 主题 ---------- */
const dark = ref(document.documentElement.classList.contains('dark'));
function toggleTheme(): void {
  dark.value = !dark.value;
  document.documentElement.classList.toggle('dark', dark.value);
  try {
    localStorage.setItem('qingyu.admin.theme', dark.value ? 'dark' : 'light');
  } catch {
    /* ignore */
  }
}

/* ---------- 移动端抽屉 ---------- */
const drawerOpen = ref(false);
function navigate(to: string): void {
  drawerOpen.value = false;
  void router.push(to);
}

/* ---------- 退出 ---------- */
const loggingOut = ref(false);
async function logout(): Promise<void> {
  loggingOut.value = true;
  try {
    await api.logout();
  } catch {
    /* 会话可能已失效，忽略 */
  } finally {
    session.clear();
    loggingOut.value = false;
    toast.info('已退出登录');
    void router.replace({ name: 'login' });
  }
}
</script>

<template>
  <div class="min-h-full flex">
    <!-- 背景遮罩（移动端抽屉打开时） -->
    <Transition name="fade">
      <div
        v-if="drawerOpen"
        class="fixed inset-0 z-30 bg-black/40 lg:hidden"
        @click="drawerOpen = false"
      />
    </Transition>

    <!-- 侧栏 -->
    <aside
      class="fixed inset-y-0 left-0 z-40 w-[248px] flex flex-col border-r border-line bg-surface
             transition-transform duration-200 lg:translate-x-0 lg:static lg:z-auto"
      :class="drawerOpen ? 'translate-x-0' : '-translate-x-full'"
    >
      <!-- 品牌 -->
      <div class="h-16 flex items-center gap-2.5 px-5 shrink-0">
        <span class="grid place-items-center size-8 rounded-[10px] bg-accent text-white shadow-xs">
          <PenLine :size="17" :stroke-width="2.4" />
        </span>
        <div class="leading-tight min-w-0">
          <div class="text-[15px] font-semibold tracking-tight truncate">轻语博客</div>
          <div class="text-[11px] text-ink-muted">管理后台</div>
        </div>
        <button class="btn btn-ghost btn-icon ml-auto lg:hidden" aria-label="关闭菜单" @click="drawerOpen = false">
          <X :size="18" />
        </button>
      </div>

      <!-- 导航 -->
      <nav class="flex-1 overflow-y-auto px-3 pb-4">
        <div v-for="group in navGroups" :key="group.label" class="mb-5">
          <div class="px-2.5 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
            {{ group.label }}
          </div>
          <button
            v-for="item in group.items"
            :key="item.to"
            class="w-full flex items-center gap-2.5 h-9 px-2.5 rounded-[9px] text-sm font-medium
                   transition-colors"
            :class="
              item.match.test(route.path)
                ? 'bg-accent-soft text-accent'
                : 'text-ink-soft hover:bg-surface-2 hover:text-ink'
            "
            @click="navigate(item.to)"
          >
            <component :is="item.icon" :size="17" :stroke-width="item.match.test(route.path) ? 2.4 : 2" />
            <span class="truncate">{{ item.label }}</span>
          </button>
        </div>
      </nav>

      <!-- 底部操作 -->
      <div class="shrink-0 border-t border-line p-3 space-y-1">
        <a
          href="/admin-legacy"
          class="flex items-center gap-2.5 h-9 px-2.5 rounded-[9px] text-sm text-ink-soft
                 hover:bg-surface-2 hover:text-ink transition-colors"
        >
          <ExternalLink :size="17" />
          <span>旧版后台</span>
        </a>
        <button
          class="w-full flex items-center gap-2.5 h-9 px-2.5 rounded-[9px] text-sm text-ink-soft
                 hover:bg-surface-2 hover:text-ink transition-colors disabled:opacity-50"
          :disabled="loggingOut"
          @click="logout"
        >
          <LogOut :size="17" />
          <span>退出登录</span>
        </button>
      </div>
    </aside>

    <!-- 主区域 -->
    <div class="flex-1 min-w-0 flex flex-col">
      <header
        class="sticky top-0 z-20 h-16 shrink-0 flex items-center gap-3 px-4 lg:px-8
               border-b border-line bg-canvas/85 backdrop-blur-md"
      >
        <button class="btn btn-ghost btn-icon lg:hidden" aria-label="打开菜单" @click="drawerOpen = true">
          <Menu :size="19" />
        </button>

        <h1 class="text-[17px] font-semibold tracking-tight truncate">{{ pageTitle }}</h1>

        <div class="ml-auto flex items-center gap-2">
          <slot name="actions" />
          <button class="btn btn-ghost btn-icon" :aria-label="dark ? '切换到浅色' : '切换到深色'" @click="toggleTheme">
            <Sun v-if="dark" :size="18" />
            <Moon v-else :size="18" />
          </button>
        </div>
      </header>

      <main class="flex-1 px-4 lg:px-8 py-6">
        <div class="mx-auto max-w-6xl">
          <slot />
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>