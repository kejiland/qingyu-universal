/* ============================================================
 * /posts.min.js 动态生成
 * ------------------------------------------------------------
 * 这个文件是 app.js 首帧的数据源（window.BLOG_POSTS）：
 *   · 上游由后台「导出静态站点」生成，带真实文章 → 首帧就有列表；
 *   · 自托管版如果沿用空的 posts.min.js，app.js 启动时会先渲染骨架屏、
 *     等 /api/posts 回来才长出列表，首页会明显闪两下。
 * 因此这里按 DB 实时生成，并要求与 /api/posts 的公开摘要同形。
 * ============================================================ */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createD1 } from '../src/bindings/d1.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import { runMigrations } from '../src/migrate.js';
import { createPostsJsHandler } from '../src/routes/posts-js.js';
import { toClientPost, toPublicSummary } from '../src/ssr/post-payload.js';

function ctx(url: string, headers: Record<string, string> = {}) {
  return {
    req: {
      url,
      header: (name: string) => headers[name.toLowerCase()]
    },
    body: (body: Buffer | string, status: number, hdrs: Record<string, string>) => {
      return new Response(body, { status, headers: hdrs });
    }
  } as unknown as Parameters<ReturnType<typeof createPostsJsHandler>>[0];
}

async function setup(): Promise<{ dir: string; db: ReturnType<typeof createD1> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-postsjs-'));
  const db = createD1(path.join(dir, 'p.db'));
  await runMigrations(db, MIGRATIONS_DIR);
  const ins = db.native.prepare(
    'INSERT INTO posts (id,title,date,excerpt,content,cover,og_image,pinned,protected,enc,tags,category,series,author,series_order,status,publish_at,seo) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  ins.run('p1', '第一篇', '2026-05-01', '摘要一', '正文一', '/a.png', '', 0, 0, null, '["A","B"]', '教程', '', '站长', 0, 'published', null, null);
  ins.run('p2', '草稿', '2026-04-01', '', '草稿正文', '', '', 0, 0, null, '[]', '', '', '', 0, 'draft', null, null);
  ins.run('p3', '加密篇', '2026-03-01', '', '不该出库的明文', '', '', 0, 1, '{"salt":"x"}', '[]', '', '', '', 0, 'published', null, null);
  return { dir, db };
}

describe('posts.min.js · 动态生成', () => {
  it('输出 window.BLOG_POSTS 且只含已发布文章', async () => {
    const { dir, db } = await setup();
    try {
      const handler = createPostsJsHandler(db);
      const res = await handler(ctx('http://localhost/posts.min.js'));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('javascript');

      const text = await res.text();
      expect(text.startsWith('window.BLOG_POSTS = [')).toBe(true);
      const arr = JSON.parse(text.replace(/^window\.BLOG_POSTS = /, '').replace(/;\s*$/, '')) as Array<Record<string, unknown>>;
      expect(arr.map((p) => p.id).sort()).toEqual(['p1', 'p3']);

      // 与 app.js 的读取点对齐：tags 必须是数组、ogImage 是驼峰、seo 是对象
      const first = arr.find((p) => p.id === 'p1')!;
      expect(first.tags).toEqual(['A', 'B']);
      expect(first).toHaveProperty('ogImage');
      expect(first.seo).toBeTypeOf('object');
      // 公开摘要形态：非加密文章带 search（正文前 800 字），不向下发 content
      expect(first.search).toBe('正文一');
      expect(first).not.toHaveProperty('content');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('受保护文章的明文正文绝不出现在产物里', async () => {
    const { dir, db } = await setup();
    try {
      const res = await createPostsJsHandler(db)(ctx('http://localhost/posts.js'));
      const text = await res.text();
      expect(text).not.toContain('不该出库的明文');
      const arr = JSON.parse(text.replace(/^window\.BLOG_POSTS = /, '').replace(/;\s*$/, '')) as Array<Record<string, unknown>>;
      const locked = arr.find((p) => p.id === 'p3')!;
      expect(locked.protected).toBe(true);
      expect(locked.content).toBe(undefined);
      expect(locked.search).toBe(undefined);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('带 ETag：命中 if-none-match 时返回 304', async () => {
    const { dir, db } = await setup();
    try {
      const handler = createPostsJsHandler(db);
      const first = await handler(ctx('http://localhost/posts.min.js'));
      const etag = first.headers.get('etag')!;
      expect(etag).toBeTruthy();
      const second = await handler(ctx('http://localhost/posts.min.js', { 'if-none-match': etag }));
      expect(second.status).toBe(304);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('映射器与上游 postFromRow 同形（含置顶、系列、加密字段）', () => {
    const post = toClientPost({
      id: 'x', title: 'T', date: 'd', excerpt: 'e', content: 'c', cover: 'cv',
      og_image: 'og', pinned: 1, protected: 0, tags: '["t1"]', category: 'cat',
      series: 's', author: 'a', series_order: 2, status: 'published', seo: '{"title":"S"}'
    });
    expect(post).toMatchObject({
      id: 'x', title: 'T', date: 'd', excerpt: 'e', content: 'c', cover: 'cv',
      ogImage: 'og', pinned: true, protected: false, enc: null,
      category: 'cat', series: 's', author: 'a', seriesOrder: 2,
      status: 'published', publishAt: null, tags: ['t1']
    });
    expect(post.seo).toEqual({ title: 'S' });

    const summary = toPublicSummary({ id: 'y', title: 'T', content: 'abc', status: 'published' });
    expect(summary.search).toBe('abc');
    expect(summary.content).toBe(undefined);
  });
});
