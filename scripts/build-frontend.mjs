import fs from 'node:fs/promises';
import path from 'node:path';
import { transform } from 'esbuild';

const jobs = [
  { src: 'app/public/app.js', out: 'app/public/app.min.js' },
  { src: 'app/public/admin.js', out: 'app/public/admin.min.js' },
  { src: 'app/public/admin.css', out: 'app/public/admin.min.css', loader: 'css' },
  { src: 'app/public/admin-legacy.js', out: 'app/public/admin-legacy.min.js' },
  { src: 'app/public/boot.js', out: 'app/public/boot.min.js' },
  { src: 'app/public/i18n.js', out: 'app/public/i18n.min.js' },
  // style.min.css 必须由 style.css 重新压缩：我们对 style.css 做过主题色 WCAG 校准，
  // 直接沿用上游的 style.min.css 会让校准形同虚设（页面只加载 .min.css）。
  { src: 'app/public/style.css', out: 'app/public/style.min.css', loader: 'css' },
  { src: 'app/public/polish.css', out: 'app/public/polish.min.css', loader: 'css' }
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
