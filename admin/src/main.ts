import { createApp } from 'vue';
import './style.css';
import App from './App.vue';
import { router } from './router';
import { setUnauthorizedHandler } from './lib/api';
import { initI18n } from './lib/i18n';

// 任何请求返回 401 就清登录态并回到登录页
setUnauthorizedHandler(() => {
  void router.replace({ name: 'login' });
});

/* 先把词典拉下来再挂载：t() 在词典就绪前会把键名原样吐出来，
 * 先挂载的话首屏会闪一下「admin.sidebar.dashboard」这种键名。 */
async function bootstrap(): Promise<void> {
  await initI18n();
  createApp(App).use(router).mount('#app');
}

void bootstrap();
