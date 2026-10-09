<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch, type Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  FileText, Image as ImageIcon, MessageSquare, Settings, Users, DatabaseBackup,
  ScrollText, LogOut, Moon, Sun, Menu, X, PenLine, AtSign, BarChart3, Sparkles,
  Tag, Layers, Clock, Music, Download, Gauge, TrendingUp, HeartPulse, Loader2, ExternalLink,
  Palette, Check
} from '@lucide/vue';
import { api, session } from '../../lib/api';
import { toast } from '../../lib/toast';
import { ACCENT_PALETTES, getAccent, setAccent, watchAccent } from '../../lib/accent';

const route = useRoute();
const router = useRouter();

interface NavItem {
  to: string;
  label: string;
  icon: Component;
  match: RegExp;
  badge?: 'pending';
}

interface NavGroup {
  label: string;
  items: NavItem[];
}
const navGroups: NavGroup[] = [
  {
    label: '概览',
    items: [
      { to: '/', label: '仪表盘', icon: Gauge, match: /^\/$/ }
    ]
  },
  {
    label: '内容',
    items: [
      { to: '/posts', label: '文章', icon: FileText, match: /^\/posts/ },
      { to: '/media', label: '媒体库', icon: ImageIcon, match: /^\/media/ },
      { to: '/comments', label: '评论', icon: MessageSquare, match: /^\/comments\/?$/ },
      { to: '/comments/pending', label: '待审评论', icon: Clock, match: /^\/comments\/pending/, badge: 'pending' },
      { to: '/tags', label: '标签管理', icon: Tag, match: /^\/tags/ },
      { to: '/series', label: '系列管理', icon: Layers, match: /^\/series/ },
      { to: '/webmentions', label: 'Webmention', icon: AtSign, match: /^\/webmentions/ }
    ]
  },
  {
    label: '站点',
    items: [
      { to: '/settings', label: '设置', icon: Settings, match: /^\/settings/ },
      { to: '/subscribers', label: '订阅者', icon: Users, match: /^\/subscribers/ },
      { to: '/stats', label: '统计', icon: BarChart3, match: /^\/stats/ },
      { to: '/analytics', label: '详细统计', icon: TrendingUp, match: /^\/analytics/ },
      { to: '/music', label: '音乐管理', icon: Music, match: /^\/music/ }
    ]
  },
  {
    label: '系统',
    items: [
      { to: '/backups', label: '备份', icon: DatabaseBackup, match: /^\/backups/ },
      { to: '/logs', label: '日志', icon: ScrollText, match: /^\/logs/ },
      { to: '/import-export', label: '导入导出', icon: Download, match: /^\/import-export/ },
      { to: '/health', label: '健康检查', icon: HeartPulse, match: /^\/health/ }
    ]
  }
];

/** 待审评论角标：进入后台时取一次，之后每分钟与切到评论页时刷新 */
const pendingCount = ref(0);
let pendingTimer: ReturnType<typeof setInterval> | undefined;
async function refreshPending(): Promise<void> {
  try {
    const data = await api.listComments('pending');
    pendingCount.value = data.comments?.length ?? 0;
  } catch {
    /* 角标拿不到就不显示 */
  }
}
onMounted(() => {
  void refreshPending();
  pendingTimer = setInterval(refreshPending, 60_000);
});
onBeforeUnmount(() => {
  if (pendingTimer) clearInterval(pendingTimer);
});
watch(
  () => route.path,
  (path) => {
    if (path.startsWith('/comments')) void refreshPending();
  }
);

const pageTitle = computed(() => (route.meta.title as string | undefined) ?? '管理后台');

/* ---------- 主题色：与前台博客共用 localStorage ---------- */
const accent = ref(getAccent());
function pickAccent(id: string): void {
  accent.value = id;
  setAccent(id);
}
let stopAccentWatch: (() => void) | undefined;
onMounted(() => {
  stopAccentWatch = watchAccent((id) => {
    accent.value = id;
  });
});
onBeforeUnmount(() => {
  stopAccentWatch?.();
});

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

/* ---------- 主题色浮层 ---------- */
const accentOpen = ref(false);
function closeAccent(): void {
  accentOpen.value = false;
}

/* ---------- 移动端抽屉 ---------- */
const drawerOpen = ref(false);
let wasDesktop = false;
/** 视口放大到桌面宽度时收起抽屉，否则遮罩会卡住整页 */
function syncDrawerToViewport(): void {
  const desktop = window.matchMedia('(min-width: 1024px)').matches;
  if (desktop && !wasDesktop) drawerOpen.value = false;
  wasDesktop = desktop;
}
onMounted(() => {
  syncDrawerToViewport();
  window.addEventListener('resize', syncDrawerToViewport);
});
onBeforeUnmount(() => window.removeEventListener('resize', syncDrawerToViewport));
function navigate(to: string): void {
  drawerOpen.value = false;
  void router.push(to);
}

/* ---------- 重新打开上手引导 ---------- */
function openGuide(): void {
  window.dispatchEvent(new CustomEvent('qy:open-welcome'));
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
      class="adm-sider z-40 flex flex-col transition-transform duration-200 lg:translate-x-0"
      :class="drawerOpen ? 'translate-x-0' : '-translate-x-full'"
    >
      <!-- 品牌 -->
      <div class="adm-sider-head flex items-center gap-2.5 px-4 shrink-0">
        <span class="adm-logo grid place-items-center size-8 text-white shrink-0">
          <PenLine :size="17" :stroke-width="2.4" />
        </span>
        <div class="leading-tight min-w-0">
          <div class="adm-brand-name truncate">轻语博客</div>
          <div class="adm-brand-sub leading-tight">管理后台</div>
        </div>
        <button class="adm-sider-close btn btn-ghost btn-icon ml-auto lg:hidden" aria-label="关闭菜单" @click="drawerOpen = false">
          <X :size="18" />
        </button>
      </div>

      <!-- 导航 -->
      <nav class="admin-side-nav min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4">
        <div v-for="group in navGroups" :key="group.label" class="mb-5">
          <div class="adm-group-title px-2.5 mb-2">
            {{ group.label }}
          </div>
          <button
            v-for="item in group.items"
            :key="item.to"
            class="adm-nav-item w-full flex items-center gap-2.5 h-9 px-3 text-[13.5px] font-medium"
            :class="item.match.test(route.path) ? 'is-active' : ''"
            :aria-current="item.match.test(route.path) ? 'page' : undefined"
            @click="navigate(item.to)"
          >
            <component :is="item.icon" :size="17" :stroke-width="item.match.test(route.path) ? 2.4 : 2" />
            <span class="truncate">{{ item.label }}</span>
            <span
              v-if="item.badge === 'pending' && pendingCount > 0"
              class="adm-nav-badge ml-auto min-w-[20px] h-[18px] px-1.5 grid place-items-center rounded-full text-[11px] font-semibold tabular-nums"
            >
              {{ pendingCount > 99 ? '99+' : pendingCount }}
            </span>
          </button>
        </div>
      </nav>

      <!-- 底部操作 -->
      <div class="adm-sider-foot shrink-0 p-3 space-y-1">
        <a
          href="/"
          target="_blank"
          rel="noopener"
          class="adm-foot-item w-full flex items-center gap-2.5 h-9 px-3 text-[13.5px]"
        >
          <ExternalLink :size="17" />
          <span class="truncate">查看博客</span>
        </a>

        <button
          class="adm-foot-item w-full flex items-center gap-2.5 h-9 px-3 text-[13.5px]"
          @click="openGuide"
        >
          <Sparkles :size="17" />
          <span>新手上路</span>
        </button>

        <button
          class="adm-foot-item w-full flex items-center gap-2.5 h-9 px-3 text-[13.5px] disabled:opacity-50"
          :disabled="loggingOut"
          @click="logout"
        >
          <Loader2 v-if="loggingOut" :size="17" class="animate-spin" />
          <LogOut v-else :size="17" />
          <span>{{ loggingOut ? '正在退出…' : '退出登录' }}</span>
        </button>
      </div>
    </aside>

    <!-- 主区域 -->
    <div class="flex-1 min-w-0 flex flex-col">
      <header
        class="adm-topbar sticky top-0 z-20 shrink-0 flex items-center gap-3 px-4 lg:px-8"
      >
        <button class="btn btn-ghost btn-icon lg:hidden" aria-label="打开菜单" @click="drawerOpen = true">
          <Menu :size="19" />
        </button>

        <h1 class="text-[17px] font-semibold tracking-tight truncate">{{ pageTitle }}</h1>

        <div class="ml-auto flex items-center gap-2">
          <slot name="actions" />

          <!-- 主题色：与前台博客共用同一份选择 -->
          <div class="relative">
            <button
              class="btn btn-ghost btn-icon"
              :class="accentOpen ? 'bg-surface-2 text-ink' : ''"
              aria-label="主题色"
              :aria-expanded="accentOpen"
              aria-haspopup="true"
              @click="accentOpen = !accentOpen"
            >
              <Palette :size="18" />
            </button>
            <Transition name="pop">
              <div
                v-if="accentOpen"
                class="absolute right-0 top-[calc(100%+8px)] z-50 w-56 card p-2 shadow-lg"
                role="menu"
                aria-label="主题色"
              >
                <div class="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                  主题色
                </div>
                <button
                  v-for="p in ACCENT_PALETTES"
                  :key="p.id"
                  role="menuitemradio"
                  :aria-checked="accent === p.id"
                  class="w-full flex items-center gap-2.5 h-9 px-2 rounded-[9px] text-sm transition-colors"
                  :class="accent === p.id ? 'bg-accent-soft text-accent font-medium' : 'text-ink-soft hover:bg-surface-2 hover:text-ink'"
                  @click="pickAccent(p.id)"
                >
                  <span
                    class="size-4 rounded-full shrink-0 ring-1 ring-black/10 dark:ring-white/15"
                    :style="{ background: p.dot }"
                  />
                  <span class="truncate">{{ p.label }}</span>
                  <Check v-if="accent === p.id" :size="15" class="ml-auto" />
                </button>
                <p class="px-2 pt-1.5 pb-0.5 text-[11px] leading-snug text-ink-muted">
                  与博客前台共用同一份设置，两边会保持一致。
                </p>
              </div>
            </Transition>
          </div>
          <button class="btn btn-ghost btn-icon" :aria-label="dark ? '切换到浅色' : '切换到深色'" @click="toggleTheme">
            <Sun v-if="dark" :size="18" />
            <Moon v-else :size="18" />
          </button>
        </div>
      </header>

      <main class="flex-1 px-4 lg:px-8 py-6" @click="closeAccent">
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

.pop-enter-active,
.pop-leave-active {
  transition: opacity 0.15s ease, transform 0.15s cubic-bezier(0.22, 1, 0.36, 1);
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.97);
}
</style>