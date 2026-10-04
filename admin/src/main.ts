import { createApp } from 'vue';
import './style.css';
import App from './App.vue';
import { router } from './router';
import { setUnauthorizedHandler } from './lib/api';

// 任何请求返回 401 就清登录态并回到登录页
setUnauthorizedHandler(() => {
  void router.replace({ name: 'login' });
});

createApp(App).use(router).mount('#app');