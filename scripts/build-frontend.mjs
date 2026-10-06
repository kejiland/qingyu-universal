import fs from 'node:fs/promises';
import path from 'node:path';
import { transform } from 'esbuild';

const jobs = [
  { src: 'app/public/app.js', out: 'app/public/app.min.js' },
  { src: 'app/public/admin-legacy.js', out: 'app/public/admin-legacy.min.js' },
  { src: 'app/public/boot.js', out: 'app/public/boot.min.js' },
  { src: 'app/public/i18n.js', out: 'app/public/i18n.min.js' },
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
