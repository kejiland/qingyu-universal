import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { session } from './lib/api';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('./views/DashboardView.vue'),
    meta: { title: '仪表盘' }
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('./views/LoginView.vue'),
    meta: { public: true, title: '登录' }
  },
  {
    path: '/posts',
    name: 'posts',
    component: () => import('./views/PostsView.vue'),
    meta: { title: '文章' }
  },
  {
    path: '/posts/new',
    name: 'post-new',
    component: () => import('./views/PostEditorView.vue'),
    meta: { title: '新建文章' }
  },
  {
    path: '/posts/:id/edit',
    name: 'post-edit',
    component: () => import('./views/PostEditorView.vue'),
    meta: { title: '编辑文章' }
  },
  {
    path: '/media',
    name: 'media',
    component: () => import('./views/MediaView.vue'),
    meta: { title: '媒体库' }
  },
  {
    path: '/music',
    name: 'music',
    component: () => import('./views/MusicView.vue'),
    meta: { title: '音乐管理' }
  },
  {
    path: '/import-export',
    name: 'import-export',
    component: () => import('./views/TransferView.vue'),
    meta: { title: '导入导出' }
  },
  {
    path: '/comments',
    name: 'comments',
    component: () => import('./views/CommentsView.vue'),
    meta: { title: '评论' }
  },
  {
    path: '/tags',
    name: 'tags',
    component: () => import('./views/TagsView.vue'),
    meta: { title: '标签管理' }
  },
  {
    path: '/series',
    name: 'series',
    component: () => import('./views/SeriesView.vue'),
    meta: { title: '系列管理' }
  },
  {
    path: '/comments/pending',
    name: 'comments-pending',
    component: () => import('./views/CommentsView.vue'),
    meta: { title: '待审核评论' }
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('./views/SettingsView.vue'),
    meta: { title: '设置' }
  },
  {
    path: '/settings/advanced',
    name: 'settings-advanced',
    component: () => import('./views/AdvancedSettingsView.vue'),
    meta: { title: '高级设置' }
  },
  {
    path: '/backups',
    name: 'backups',
    component: () => import('./views/BackupsView.vue'),
    meta: { title: '备份' }
  },
  {
    path: '/logs',
    name: 'logs',
    component: () => import('./views/LogsView.vue'),
    meta: { title: '日志' }
  },
  {
    path: '/subscribers',
    name: 'subscribers',
    component: () => import('./views/SubscribersView.vue'),
    meta: { title: '订阅者' }
  },
  {
    path: '/webmentions',
    name: 'webmentions',
    component: () => import('./views/WebmentionsView.vue'),
    meta: { title: 'Webmention' }
  },
  {
    path: '/stats',
    name: 'stats',
    component: () => import('./views/StatsView.vue'),
    meta: { title: '统计' }
  },
  {
    path: '/analytics',
    name: 'analytics',
    component: () => import('./views/AnalyticsView.vue'),
    meta: { title: '详细统计' }
  },
  {
    path: '/health',
    name: 'health',
    component: () => import('./views/HealthView.vue'),
    meta: { title: '健康检查' }
  },
  // 未登记的管理路径显示占位页
  {
    path: '/:pathMatch(.*)*',
    name: 'placeholder',
    component: () => import('./views/PlaceholderView.vue'),
    meta: { title: '尚未迁移' }
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