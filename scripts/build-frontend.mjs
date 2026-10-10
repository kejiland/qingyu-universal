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
  { src: 'app/public/polish.css', out: 'app/public/polish.min.css', loader: 'css' },
  { src: 'app/public/style.css', out: 'app/public/style.min.css', loader: 'css' },
  { src: 'app/public/music-player.css', out: 'app/public/music-player.min.css', loader: 'css' },
  { src: 'app/public/music-player.js', out: 'app/public/music-player.min.js' },
  { src: 'app/public/posts.js', out: 'app/public/posts.min.js' },
  { src: 'app/public/bg-anim.js', out: 'app/public/bg-anim.min.js' },
  { src: 'app/public/config.js', out: 'app/public/config.min.js' }
];

async function buildOne(job) {
  const source = await fs.readFile(job.src, 'utf8');
  const result = await transform(source, {
    loader: job.loader || 'js',
    minify: true,
    target: 'es2018',
    charset: 'utf8'
  });
  await fs.writeFile(job.out, result.code);
  console.log(`${path.basename(job.src)} -> ${path.basename(job.out)} (${result.code.length} bytes)`);
}

for (const job of jobs) await buildOne(job);

/* ---------- \u9759\u6001\u8d44\u6e90\u7248\u672c\u53f7\uff08\u81ea\u52a8\u53d8\u5316\uff09 ----------
 * \u524d\u7aef\u7528 BLOG_VERSION \u7ed9\u9759\u6001\u8d44\u6e90\u52a0 ?v= \u67e5\u8be2\u53c2\uff0c
 * Service Worker \u53c8\u6309\u540c\u4e00\u4e2a\u53f7\u9694\u79bb\u81ea\u5df1\u7684\u7f13\u5b58\u3002
 * \u4e4b\u524d\u8fd9\u4e2a\u53f7\u662f\u624b\u52a8\u7684\uff08\u6539\u4e86\u524d\u7aef\u4e5f\u5f80\u5fd8\u6539\uff09\uff0c\u6240\u4ee5\u53d1\u5e03\u65b0\u7248\u540e
 * \u624b\u673a\u4ecd\u7136\u62ff\u5230\u65e7\u7684 ?v= \u7f13\u5b58\uff0c\u7528\u6237\u5f97\u624b\u52a8\u6e05\u7f13\u5b58\u624d\u80fd\u770b\u5230\u65b0\u7248\u3002
 * \u73b0\u5728\u6539\u4e3a\uff1a\u5bf9\u5168\u90e8\u538b\u7f29\u4ea7\u7269\u7b97\u5185\u5bb9\u54c8\u5e0c\uff0c\u5185\u5bb9\u4e00\u53d8\u5c31\u81ea\u52a8\u53d8\u53f7\u3002 */
async function stampVersion() {
  const crypto = await import('node:crypto');

  // 只哈希**源文件**，不哈希压缩产物：
  // 否则版本号会被自己写进 app.min.js 引起循环，每构建一次就变。
  // app.js / sw.js 里的版本号行先归一化掉再哈希，保证内容不变就得到同一个号。
  const files = [...jobs.map((j) => j.src), 'app/public/sw.js'];
  const h = crypto.createHash('sha256');
  for (const file of files) {
    let text = await fs.readFile(file, 'utf8');
    text = text.replace(/var (BLOG|CACHE)_VERSION = '[^']*';/g, 'var $1_VERSION = <stamped>;');
    h.update(text);
  }
  const version = 'b' + h.digest('hex').slice(0, 8);

  const appPath = 'app/public/app.js';
  const app = await fs.readFile(appPath, 'utf8');
  const appNext = app.replace(/var BLOG_VERSION = '[^']*';/, `var BLOG_VERSION = '${version}';`);
  // 内容未变时版本号也不变（重复构建应得到同一个号），
  // 因此只在真的找不到那行时才报错。
  if (!/var BLOG_VERSION = '[^']*';/.test(app)) throw new Error('BLOG_VERSION 未找到，请检查 app.js');
  await fs.writeFile(appPath, appNext);

  const swPath = 'app/public/sw.js';
  const sw = await fs.readFile(swPath, 'utf8');
  const swNext = sw.replace(/var CACHE_VERSION = '[^']*';/, `var CACHE_VERSION = '${version}';`);
  if (!/var CACHE_VERSION = '[^']*';/.test(sw)) throw new Error('CACHE_VERSION 未找到，请检查 sw.js');
  await fs.writeFile(swPath, swNext);

  // index.html 里的 ?v= 是硬编码的，同步换成同一个号：
  // 否则 HTML 指的是新版本号、脚本内部请求的是旧版本号，既白白多一轮请求又不能刷新式样式。
  const htmlPath = 'app/public/index.html';
  const html = await fs.readFile(htmlPath, 'utf8');
  const htmlNext = html.replace(/\?v=[0-9a-z.]+/g, `?v=${version}`);
  if (htmlNext === html && !/\?v=/.test(html)) throw new Error('index.html 里没有 ?v= 参数，请确认版本号写法');
  await fs.writeFile(htmlPath, htmlNext);
  // app.min.js 内嵌了版本号，刷个版后重新压缩一次
  await buildOne(jobs[0]);
  console.log(`静态资源版本号 → ${version}`);
}

await stampVersion();
