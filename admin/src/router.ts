import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { session } from './lib/api';

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/posts' },
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
    path: '/comments',
    name: 'comments',
    component: () => import('./views/CommentsView.vue'),
    meta: { title: '评论' }
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('./views/SettingsView.vue'),
    meta: { title: '设置' }
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
  // 仍未迁移的模块（订阅者 / 统计 / Webmention）：占位页 + 跳转旧版，功能不丢失
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
  if (to.name === 'login' && authed) return { name: 'posts' };
  return true;
});