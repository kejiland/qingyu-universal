import fs from 'node:fs/promises';
import path from 'node:path';
import { transform } from 'esbuild';

/* 源文件 → 压缩产物。清单必须覆盖 app/public 下每一个 *.min.* 文件：
 * 少登记一项，那份压缩产物就会一直停留在旧版本，
 * 站点加载的是压缩产物，改源码却看不出任何效果（很难排查）。
 * 新增前端资源时记得同时在这里加一行。 */
const jobs = [
  { src: 'app/public/app.js', out: 'app/public/app.min.js' },
  { src: 'app/public/admin.js', out: 'app/public/admin.min.js' },
  { src: 'app/public/admin.css', out: 'app/public/admin.min.css', loader: 'css' },
  { src: 'app/public/admin-legacy.js', out: 'app/public/admin-legacy.min.js' },
  { src: 'app/public/boot.js', out: 'app/public/boot.min.js' },
  { src: 'app/public/i18n.js', out: 'app/public/i18n.min.js' },
  { src: 'app/public/polish.css', out: 'app/public/polish.min.css', loader: 'css' },
  { src: 'app/public/style.css', out: 'app/public/style.min.css', loader: 'css' },
  { src: 'app/public/music-player.css', out: 'app/public/music-player.min.css', loader: 'css' },
  { src: 'app/public/music-player.js', out: 'app/public/music-player.min.js' },
  { src: 'app/public/posts.js', out: 'app/public/posts.min.js' },
  { src: 'app/public/bg-anim.js', out: 'app/public/bg-anim.min.js' },
  { src: 'app/public/config.js', out: 'app/public/config.min.js' }
];

for (const job of jobs) {
  const source = await fs.readFile(job.src, 'utf8');
  const result = await transform(source, {
    loader: job.loader || 'js',
    minify: true,
    // 保持经典脚本语义：旧后台分包依赖顶层函数挂到 window。
    target: 'es2018',
    charset: 'utf8'
  });
  await fs.writeFile(job.out, result.code);
  console.log(`${path.basename(job.src)} -> ${path.basename(job.out)} (${result.code.length} bytes)`);
}
