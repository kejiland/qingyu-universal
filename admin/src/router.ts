import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { session } from './lib/api';

/* 路由只登记文案**键**（titleKey / subtitleKey），不写死中文：
 * AdminLayout 在渲染时用 t() 取当前语言的文案，切语言整页跟着变。
 * 键名与上游旧版后台同一批（admin.*），因此两边措辞天然一致。
 * 漏写键不会静默变空白：t() 会原样吐出键名，测试 tests/admin-i18n.test.ts 会把关。 */
const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('./views/DashboardView.vue'),
    meta: { titleKey: 'admin.sidebar.dashboard', subtitleKey: 'admin.dashboard.desc' }
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('./views/LoginView.vue'),
    meta: { public: true, titleKey: 'admin.login' }
  },
  {
    path: '/posts',
    name: 'posts',
    component: () => import('./views/PostsView.vue'),
    meta: { titleKey: 'admin.sidebar.allPosts', subtitleKey: 'admin.postList.desc' }
  },
  {
    path: '/posts/new',
    name: 'post-new',
    component: () => import('./views/PostEditorView.vue'),
    meta: { titleKey: 'admin.sidebar.writeNew', subtitleKey: 'admin.extra.newPostDesc' }
  },
  {
    path: '/posts/:id/edit',
    name: 'post-edit',
    component: () => import('./views/PostEditorView.vue'),
    meta: { titleKey: 'admin.editor.editPost', subtitleKey: 'admin.extra.editPostDesc' }
  },
  {
    path: '/media',
    name: 'media',
    component: () => import('./views/MediaView.vue'),
    meta: { titleKey: 'admin.sidebar.media', subtitleKey: 'admin.media.desc' }
  },
  {
    path: '/music',
    name: 'music',
    component: () => import('./views/MusicView.vue'),
    meta: { titleKey: 'admin.sidebar.musicManage', subtitleKey: 'admin.music.desc' }
  },
  {
    path: '/import-export',
    name: 'import-export',
    component: () => import('./views/TransferView.vue'),
    meta: { titleKey: 'admin.sidebar.importExport', subtitleKey: 'admin.transfer.desc' }
  },
  {
    path: '/comments',
    name: 'comments',
    component: () => import('./views/CommentsView.vue'),
    meta: { titleKey: 'admin.sidebar.allComments', subtitleKey: 'admin.comments.desc' }
  },
  {
    path: '/tags',
    name: 'tags',
    component: () => import('./views/TagsView.vue'),
    meta: { titleKey: 'admin.sidebar.tagManage', subtitleKey: 'admin.tags.desc' }
  },
  {
    path: '/series',
    name: 'series',
    component: () => import('./views/SeriesView.vue'),
    meta: { titleKey: 'admin.sidebar.seriesManage', subtitleKey: 'admin.series.desc' }
  },
  {
    path: '/comments/pending',
    name: 'comments-pending',
    component: () => import('./views/CommentsView.vue'),
    meta: { titleKey: 'admin.sidebar.pendingComments', subtitleKey: 'admin.extra.pendingDesc' }
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('./views/SettingsView.vue'),
    meta: { titleKey: 'admin.sidebar.settings', subtitleKey: 'admin.settings.desc' }
  },
  {
    path: '/settings/advanced',
    name: 'settings-advanced',
    component: () => import('./views/AdvancedSettingsView.vue'),
    meta: {
      titleKey: 'admin.extra.advancedSettings',
      subtitleKey: 'admin.extra.advancedSettingsDesc'
    }
  },
  {
    path: '/backups',
    name: 'backups',
    component: () => import('./views/BackupsView.vue'),
    meta: { titleKey: 'admin.sidebar.backups', subtitleKey: 'admin.backup.desc' }
  },
  /* 上游后台把「操作日志」「错误日志」拆成两个侧栏入口，这里同样拆开；
   * 两页共用 LogsView，靠 meta.tab 决定默认停在哪个页签。 */
  {
    path: '/audit',
    name: 'audit',
    component: () => import('./views/LogsView.vue'),
    meta: { titleKey: 'admin.sidebar.audit', subtitleKey: 'admin.audit.desc', tab: 'audit' }
  },
  {
    path: '/errors',
    name: 'errors',
    component: () => import('./views/LogsView.vue'),
    meta: { titleKey: 'admin.sidebar.errors', subtitleKey: 'admin.errors.desc', tab: 'errors' }
  },
  // 旧路径（本项目早期版本用的 /logs）保留为跳转，避免书签失效
  { path: '/logs', redirect: { name: 'audit' } },
  /* AI 模型配置：自托管版专有。上游 Cloudflare 版直接用平台绑定 env.AI，
   * 没有网关 / Key / 模型这些概念，所以这一页在原版不存在。 */
  {
    path: '/ai',
    name: 'ai',
    component: () => import('./views/AiSettingsView.vue'),
    meta: { titleKey: 'admin.ai.title', subtitleKey: 'admin.ai.subtitle' }
  },
  {
    path: '/subscribers',
    name: 'subscribers',
    component: () => import('./views/SubscribersView.vue'),
    meta: { titleKey: 'admin.sidebar.subscribers', subtitleKey: 'admin.subscribers.desc' }
  },
  {
    path: '/webmentions',
    name: 'webmentions',
    component: () => import('./views/WebmentionsView.vue'),
    meta: { titleKey: 'admin.sidebar.webmentions', subtitleKey: 'admin.webmentions.desc' }
  },
  {
    path: '/stats',
    name: 'stats',
    component: () => import('./views/StatsView.vue'),
    meta: { titleKey: 'admin.extra.stats', subtitleKey: 'admin.extra.statsDesc' }
  },
  {
    path: '/analytics',
    name: 'analytics',
    component: () => import('./views/AnalyticsView.vue'),
    meta: { titleKey: 'admin.sidebar.analytics', subtitleKey: 'admin.analytics.desc' }
  },
  {
    path: '/health',
    name: 'health',
    component: () => import('./views/HealthView.vue'),
    meta: { titleKey: 'admin.sidebar.health', subtitleKey: 'admin.health.desc' }
  },
  // 未登记的管理路径显示占位页
  {
    path: '/:pathMatch(.*)*',
    name: 'placeholder',
    component: () => import('./views/PlaceholderView.vue'),
    meta: { titleKey: 'admin.extra.notMigrated' }
  }
];

export const router = createRouter({
  history: createWebHistory('/admin/'),
  routes,
  scrollBehavior: () => ({ top: 0 })
});

router.beforeEach((to) => {
  const authed = Boolean(session.token);
  if (!to.meta.public && !authed) {
    return { name: 'login', query: to.fullPath !== '/' ? { redirect: to.fullPath } : {} };
  }
  if (to.name === 'login' && authed) return { name: 'home' };
  return true;
});
