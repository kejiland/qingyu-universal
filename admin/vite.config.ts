import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  // 后台挂在 /admin/ 下，资源路径必须带前缀
  base: '/admin/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900
  },
  server: {
    port: 5174,
    // 开发时把 API 与媒体请求代理到本地实例
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/media': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/music': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/openapi.json': { target: 'http://127.0.0.1:8787', changeOrigin: true }
    }
  }
});