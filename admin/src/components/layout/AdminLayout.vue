<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  FileText, Image as ImageIcon, MessageSquare, Settings, Users, DatabaseBackup,
  ScrollText, LogOut, Moon, Sun, Menu, PenLine, AtSign, BarChart3, Sparkles,
  Tag, Layers, Clock, Music, Download, Gauge, TrendingUp, HeartPulse,
  ExternalLink, Lock, UserRound, KeyRound, Globe, Bug
} from '@lucide/vue';
import { api, session } from '../../lib/api';
import { LANGUAGES, langTitle, setLocale, t, useI18n } from '../../lib/i18n';
import { toast } from '../../lib/toast';

const route = useRoute();
const router = useRouter();

/* 切语言后导航、面包屑、页头都要跟着重渲染，所以这里通过 useI18n() 取
 * locale，让模板建立对它的依赖（t() 本身也会读到响应式词典）。 */
const { locale } = useI18n();

interface NavItem {
  to: string;
  /** 文案键，取值与上游旧版后台同一批（admin.sidebar.*），两边措辞天然一致 */
  labelKey: string;
  icon: Component;
  match: RegExp;
  badge?: 'pending';
}

interface NavGroup {
  labelKey: string;
  items: NavItem[];
}

/* 分组、条目命名与顺序对齐原版后台（admin.js 的 getNav()）。
 * 自托管版多出的「访问统计」插在监控类条目之前，这样上游那 9 条的
 * 相对顺序仍然是原样，两个后台的侧栏可以逐行对上。 */
const navGroups: NavGroup[] = [
  {
    labelKey: 'admin.sidebar.overview',
    items: [{ to: '/', labelKey: 'admin.sidebar.dashboard', icon: Gauge, match: /^\/$/ }]
  },
  {
    labelKey: 'admin.sidebar.postManage',
    items: [
      { to: '/posts', labelKey: 'admin.sidebar.allPosts', icon: FileText, match: /^\/posts$/ },
      { to: '/analytics', labelKey: 'admin.sidebar.analytics', icon: TrendingUp, match: /^\/analytics/ },
      { to: '/posts/new', labelKey: 'admin.sidebar.writeNew', icon: PenLine, match: /^\/posts\/new$/ },
      { to: '/tags', labelKey: 'admin.sidebar.tagManage', icon: Tag, match: /^\/tags/ },
      { to: '/series', labelKey: 'admin.sidebar.seriesManage', icon: Layers, match: /^\/series/ }
    ]
  },
  {
    labelKey: 'admin.sidebar.commentManage',
    items: [
      { to: '/comments', labelKey: 'admin.sidebar.allComments', icon: MessageSquare, match: /^\/comments\/?$/ },
      {
        to: '/comments/pending',
        labelKey: 'admin.sidebar.pendingComments',
        icon: Clock,
        match: /^\/comments\/pending/,
        badge: 'pending'
      },
      { to: '/webmentions', labelKey: 'admin.sidebar.webmentions', icon: AtSign, match: /^\/webmentions/ }
    ]
  },
  {
    labelKey: 'admin.sidebar.contentSettings',
    items: [
      { to: '/media', labelKey: 'admin.sidebar.media', icon: ImageIcon, match: /^\/media/ },
      { to: '/music', labelKey: 'admin.sidebar.musicManage', icon: Music, match: /^\/music/ },
      { to: '/subscribers', labelKey: 'admin.sidebar.subscribers', icon: Users, match: /^\/subscribers/ },
      { to: '/stats', labelKey: 'admin.extra.stats', icon: BarChart3, match: /^\/stats/ },
      { to: '/audit', labelKey: 'admin.sidebar.audit', icon: ScrollText, match: /^\/audit/ },
      { to: '/health', labelKey: 'admin.sidebar.health', icon: HeartPulse, match: /^\/health/ },
      { to: '/errors', labelKey: 'admin.sidebar.errors', icon: Bug, match: /^\/errors/ },
      { to: '/backups', labelKey: 'admin.sidebar.backups', icon: DatabaseBackup, match: /^\/backups/ },
      { to: '/import-export', labelKey: 'admin.sidebar.importExport', icon: Download, match: /^\/import-export/ },
      { to: '/settings', labelKey: 'admin.sidebar.settings', icon: Settings, match: /^\/settings/ }
    ]
  }
];

/** 当前命中的导航项；正则可能同时命中多个（如 /settings 与 /settings/advanced），
 * 取路径最长的那条，保证侧栏高亮落在最贴近的入口上。 */
function findActive(): NavItem | null {
  let best: NavItem | null = null;
  for (const group of navGroups) {
    for (const item of group.items) {
      if (!item.match.test(route.path)) continue;
      if (!best || item.to.length > best.to.length) best = item;
    }
  }
  return best;
}
const activeItem = computed<NavItem | null>(findActive);

/** 侧栏里当前页所属的分组（概览组不出现在面包屑第二段） */
const activeGroup = computed<NavGroup | null>(() => {
  const item = activeItem.value;
  if (!item) return null;
  for (const group of navGroups) {
    if (group.items.includes(item)) return group;
  }
  return null;
});

/* 页头与面包屑末段一律以路由的 titleKey 为准，导航项只用来定分组。
 * 反过来（优先取导航项文案）会让 /settings/advanced 显示成「博客设置」——
 * 因为它命中的是侧栏的 /settings 项。 */
const pageKey = computed(
  () => (route.meta.titleKey as string | undefined) ?? activeItem.value?.labelKey ?? 'admin.sidebar.dashboard'
);

/** 面包屑：概览组只显示当前页，其余显示「分组 / 当前页」（同原版 crumbsFor） */
const crumbs = computed<string[]>(() => {
  const group = activeGroup.value;
  if (!group || group.labelKey === 'admin.sidebar.overview') return [t(pageKey.value)];
  return [t(group.labelKey), t(pageKey.value)];
});

const pageTitle = computed(() => t(pageKey.value));
const pageSub = computed(() => {
  const key = route.meta.subtitleKey as string | undefined;
  return key ? t(key) : '';
});

/* ---------- 站点与作者信息：侧栏品牌区用（同原版的 logo / 头像来源） ---------- */
const identity = ref({ siteName: '轻语博客', siteLogo: '', adminName: '管理员', adminAvatar: '' });
const logoFailed = ref(false);

function safeParse(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function loadIdentity(): Promise<void> {
  try {
    const { settings } = await api.getSettings();
    const site = { ...safeParse(settings.site_info), ...safeParse(settings.site) };
    const footer = safeParse(settings.footer);
    const prof = safeParse(settings.profile);
    const siteName =
      String(footer.copyrightName ?? '').trim() || String(site.name ?? '').trim() || '轻语博客';
    identity.value = {
      siteName,
      siteLogo: String(site.avatar ?? '').trim(),
      adminName: String(prof.name ?? '').trim() || siteName,
      adminAvatar: String(prof.avatar ?? '').trim()
    };
  } catch {
    /* 拿不到就沿用默认占位，不打断后台 */
  }
}

/* ---------- 待审评论角标 ---------- */
const pendingCount = ref(0);
onMounted(async () => {
  void loadIdentity();
  try {
    const data = await api.listComments('pending');
    pendingCount.value = data.comments?.length ?? 0;
  } catch {
    /* 角标拿不到就不显示 */
  }
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

/* ---------- 侧栏：桌面折叠成图标栏 / 移动端抽屉（同原版 abMenuBtn 的行为） ---------- */
const COLLAPSE_KEY = 'qingyu.admin.siderCollapsed';
const collapsed = ref(false);
const drawerOpen = ref(false);
try {
  collapsed.value = localStorage.getItem(COLLAPSE_KEY) === '1';
} catch {
  /* ignore */
}

function isMobile(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= 991;
}

function toggleSider(): void {
  if (isMobile()) {
    drawerOpen.value = !drawerOpen.value;
    return;
  }
  collapsed.value = !collapsed.value;
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed.value ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function navigate(to: string): void {
  drawerOpen.value = false;
  if (route.path !== to) void router.push(to);
}

/* ---------- 账户菜单 ---------- */
const menuOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);

/* ---------- 语言弹层（同原版右上角 🌐 的行为） ---------- */
const langOpen = ref(false);
const langRef = ref<HTMLElement | null>(null);
const switchingLang = ref(false);

async function switchLang(code: string): Promise<void> {
  if (switchingLang.value || code === locale.value) {
    langOpen.value = false;
    return;
  }
  switchingLang.value = true;
  try {
    await setLocale(code);
  } finally {
    switchingLang.value = false;
    langOpen.value = false;
  }
}

function onDocClick(event: MouseEvent): void {
  if (menuOpen.value && menuRef.value && !menuRef.value.contains(event.target as Node)) {
    menuOpen.value = false;
  }
  if (langOpen.value && langRef.value && !langRef.value.contains(event.target as Node)) {
    langOpen.value = false;
  }
}
function onEsc(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  menuOpen.value = false;
  langOpen.value = false;
}
onMounted(() => {
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onEsc);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onEsc);
});

function go(to: string): void {
  menuOpen.value = false;
  void router.push(to);
}

/** 重新打开上手引导 */
function openGuide(): void {
  menuOpen.value = false;
  window.dispatchEvent(new CustomEvent('qy:open-welcome'));
}

/* ---------- 退出 ---------- */
const loggingOut = ref(false);
async function logout(): Promise<void> {
  if (loggingOut.value) return;
  loggingOut.value = true;
  menuOpen.value = false;
  try {
    await api.logout();
  } catch {
    /* 会话可能已失效，忽略 */
  } finally {
    session.clear();
    loggingOut.value = false;
    toast.info(t('admin.extra.loggedOut'));
    void router.replace({ name: 'login' });
  }
}
</script>

<template>
  <div class="admin-shell" :class="{ 'is-collapsed': collapsed }">
    <!-- 移动端遮罩 -->
    <button
      v-if="drawerOpen"
      class="admin-sider-mask"
      type="button"
      :aria-label="t('admin.extra.closeMenu')"
      @click="drawerOpen = false"
    />

    <!-- 侧栏 -->
    <aside class="admin-sider" :class="{ 'is-collapsed': collapsed, 'is-open': drawerOpen }">
      <div class="admin-sider-brand">
        <div class="admin-logo">
          <img
            v-if="identity.siteLogo && !logoFailed"
            :src="identity.siteLogo"
            alt=""
            @error="logoFailed = true"
          />
          <span v-else>{{ identity.siteName.slice(0, 1) }}</span>
        </div>
        <b class="admin-brand-name">{{ identity.siteName }}</b>
      </div>

      <nav class="admin-nav">
        <div v-for="group in navGroups" :key="group.labelKey" class="admin-nav-group">
          <div class="admin-nav-group-title">{{ t(group.labelKey) }}</div>
          <button
            v-for="item in group.items"
            :key="item.to"
            type="button"
            class="admin-nav-item"
            :class="{ active: activeItem === item }"
            @click="navigate(item.to)"
          >
            <span class="admin-nav-icon"><component :is="item.icon" :size="16" /></span>
            <span class="admin-nav-text">{{ t(item.labelKey) }}</span>
            <span v-if="item.badge === 'pending' && pendingCount > 0" class="admin-nav-count">
              {{ pendingCount > 99 ? '99+' : pendingCount }}
            </span>
          </button>
        </div>
      </nav>

      <div class="admin-sider-foot">
        <div class="admin-sider-avatar">
          <img v-if="identity.adminAvatar" :src="identity.adminAvatar" alt="" />
          <span v-else>{{ identity.adminName.slice(0, 1) }}</span>
        </div>
        <div class="admin-sider-foot-text">
          <b>{{ identity.adminName }}</b>
          <span>{{ t('admin.sidebar.adminDesc') }}</span>
        </div>
        <button
          class="admin-sider-btn"
          type="button"
          :title="t('admin.sidebar.logout')"
          :disabled="loggingOut"
          @click="logout"
        >
          <LogOut :size="17" />
        </button>
      </div>
    </aside>

    <!-- 主区域 -->
    <div class="admin-main">
      <header class="admin-header">
        <button
          class="admin-icon-btn"
          type="button"
          :title="collapsed ? t('admin.extra.siderExpand') : t('admin.extra.siderCollapse')"
          @click="toggleSider"
        >
          <Menu :size="18" />
        </button>

        <nav class="admin-crumb" :aria-label="t('admin.extra.breadcrumb')">
          <template v-for="(crumb, index) in crumbs" :key="index">
            <span v-if="index > 0" class="sep hidden sm:inline">/</span>
            <b v-if="index === crumbs.length - 1">{{ crumb }}</b>
            <span v-else class="hidden sm:inline">{{ crumb }}</span>
          </template>
        </nav>

        <div class="flex-1" />

        <div class="flex items-center gap-2">
          <a class="admin-header-btn" href="/" target="_blank" rel="noopener">
            <ExternalLink :size="16" />
            <span class="hidden sm:inline">{{ t('admin.header.preview') }}</span>
          </a>

          <!-- 语言切换：与前台同一套词典，切了前后台同时生效 -->
          <div ref="langRef" class="relative">
            <button
              class="admin-icon-btn"
              type="button"
              :title="langTitle()"
              aria-haspopup="listbox"
              :aria-expanded="langOpen"
              @click="langOpen = !langOpen"
            >
              <Globe :size="18" />
            </button>

            <div
              v-if="langOpen"
              class="absolute right-0 top-[calc(100%+8px)] z-50 min-w-[200px] rounded-xl border border-line bg-surface p-2 shadow-lg"
              role="listbox"
              :aria-label="langTitle()"
            >
              <div class="px-2.5 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
                {{ langTitle() }}
              </div>
              <button
                v-for="(item, index) in LANGUAGES"
                :key="item.code"
                type="button"
                class="lang-row"
                :class="{ active: item.code === locale }"
                role="option"
                :aria-selected="item.code === locale"
                :aria-posinset="index + 1"
                :aria-setsize="LANGUAGES.length"
                :disabled="switchingLang"
                @click="switchLang(item.code)"
              >
                <img
                  class="lang-flag-img"
                  :src="`/flags/${item.flag}.svg`"
                  :alt="item.code"
                  width="20"
                  height="14"
                  loading="lazy"
                />
                <span>{{ item.name }}</span>
              </button>
            </div>
          </div>

          <button
            class="admin-icon-btn"
            type="button"
            :title="dark ? t('admin.extra.themeLight') : t('admin.extra.themeDark')"
            @click="toggleTheme"
          >
            <Sun v-if="dark" :size="18" />
            <Moon v-else :size="18" />
          </button>

          <div ref="menuRef" class="relative">
            <button
              class="admin-icon-btn"
              type="button"
              :title="t('admin.header.account')"
              aria-haspopup="menu"
              :aria-expanded="menuOpen"
              @click="menuOpen = !menuOpen"
            >
              <Lock :size="18" />
            </button>

            <div
              v-if="menuOpen"
              class="absolute right-0 top-[calc(100%+8px)] z-50 min-w-[188px] rounded-xl border border-line bg-surface p-1.5 shadow-lg"
              role="menu"
            >
              <button class="menu-row" type="button" role="menuitem" @click="go('/settings/advanced')">
                <UserRound :size="15" />
                <span>{{ t('admin.header.profile') }}</span>
              </button>
              <button class="menu-row" type="button" role="menuitem" @click="go('/settings')">
                <KeyRound :size="15" />
                <span>{{ t('admin.header.changePwd') }}</span>
              </button>
              <button class="menu-row" type="button" role="menuitem" @click="openGuide">
                <Sparkles :size="15" />
                <span>{{ t('admin.extra.guide') }}</span>
              </button>
              <div class="my-1 h-px bg-line" />
              <button
                class="menu-row text-danger hover:bg-danger-soft"
                type="button"
                role="menuitem"
                :disabled="loggingOut"
                @click="logout"
              >
                <LogOut :size="15" />
                <span>{{ t('admin.sidebar.logout') }}</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <main class="admin-content">
        <div class="page-head">
          <div class="min-w-0">
            <h1 class="page-title">{{ pageTitle }}</h1>
            <p v-if="pageSub" class="page-sub">{{ pageSub }}</p>
          </div>
        </div>

        <slot />
      </main>

      <footer class="admin-foot">{{ t('admin.footer.copyright') }}</footer>
    </div>
  </div>
</template>

<style scoped>
/* 账户菜单里的一行 */
.menu-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 36px;
  padding: 0 10px;
  border-radius: 8px;
  border: 0;
  background: transparent;
  color: var(--ink-soft);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.menu-row:hover {
  background: var(--surface-2);
  color: var(--ink);
}
.menu-row:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 语言弹层里的一行（同原版 .lang-option 的观感） */
.lang-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ink-soft);
  font-size: 13.5px;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.lang-row:hover {
  background: var(--surface-2);
}
.lang-row.active {
  color: var(--primary);
  background: var(--primary-soft);
  font-weight: 600;
}
.lang-row:disabled {
  opacity: 0.6;
  cursor: default;
}
.lang-flag-img {
  display: block;
  width: 20px;
  height: 14px;
  border-radius: 2px;
  flex-shrink: 0;
  box-shadow: 0 0 0 1px rgb(0 0 0 / 0.1);
}
</style>
