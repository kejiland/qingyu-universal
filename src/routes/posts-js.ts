/* ============================================================
 * 动态生成 /posts.min.js（与 /posts.js）
 * ------------------------------------------------------------
 * 背景（首屏最大的一处跳动）：
 *   index.html 会加载 `posts.min.js` 把文章注入 `window.BLOG_POSTS`，
 *   app.js 的 `getPublishedPosts()` 读的就是它。上游部署里这个文件是
 *   后台「导出静态站点」生成的、**带真实文章**的，所以首帧渲染就有数据。
 *   自托管版把文章放在 SQLite，`posts.min.js` 是空数组 `[]` —— 于是
 *   app.js 启动时 `getPublishedPosts()` 为空、`cloudProbing` 成立，
 *   首页会先渲染**骨架屏**，等 /api/posts 回来才长出真正列表：
 *   服务端已经渲染好的列表被骨架屏顶掉再回来，肉眼可见地闪两下。
 *
 * 这里改为按 DB 实时生成同一份文件（ETag + no-cache，库变更后自动失效），
 * 前端首帧就有完整数据，SSR 与 app.js 接管后的结果一致。
 * ============================================================ */
import type { Context } from 'hono';
import { toPublicSummary } from '../ssr/post-payload.js';
import type { AppDatabase } from '../types.js';

/** 只取已发布文章；置顶靠前、其余按日期倒序（与 app.js 的首页排序一致）。 */
const POSTS_SQL =
  "SELECT * FROM posts WHERE COALESCE(status, 'published') = 'published' " +
  'ORDER BY COALESCE(pinned, 0) DESC, date DESC, id DESC';

export function createPostsJsHandler(db: AppDatabase) {
  return async (c: Context): Promise<Response> => {
    let posts: Array<Record<string, unknown>> = [];
    try {
      const rows = await db.all<Parameters<typeof toPublicSummary>[0]>(POSTS_SQL);
      // 定时发布：publish_at 在未来 → 状态为 scheduled，前端 getPublishedPosts() 会过滤掉
      posts = rows.map(toPublicSummary);
    } catch {
      /* 读库失败时给空数组：前端回落到 /api/posts，不阻塞页面 */
      posts = [];
    }

    const body = `window.BLOG_POSTS = ${JSON.stringify(posts)};\n`;
    const bytes = Buffer.from(body, 'utf8');
    const etag = `W/"posts-${bytes.length.toString(16)}-${posts.length.toString(16)}"`;

    if (c.req.header('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }

    return c.body(bytes, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Length': String(bytes.length),
      ETag: etag,
      // no-cache = 每次都带 ETag 校验，库一改立刻生效，同时命中时仍是 304 零流量
      'Cache-Control': 'no-cache'
    });
  };
}
