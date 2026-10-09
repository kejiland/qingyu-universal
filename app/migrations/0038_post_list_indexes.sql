-- ============================================================
-- 文章列表查询的索引（SSR 首页 / 归档 / 标签 / 热门的热路径）
-- ------------------------------------------------------------
-- 列表查询长这样（src/ssr/list.ts、src/ssr/pages.ts 以及上游 posts.js）：
--   WHERE COALESCE(status,'published') = 'published'
--   ORDER BY COALESCE(pinned,0) DESC, date DESC
-- posts 此前只有 idx_posts_scheduled / idx_posts_series，
-- 上面这个谓词与排序**没有任何索引可命中** —— 恒全表扫描 + 排序。
--
-- 为什么用**表达式索引**而不是改 SQL：
--   谓词把列包在 COALESCE() 里，普通索引（status, date）根本用不上；
--   而这里的 WHERE/ORDER BY 散落在上游 JS 多处，逐个改写风险大。
--   表达式索引与谓词同构，SQLite（3.9+）与 PostgreSQL 都支持，
--   于是一行不改 SQL 就能让优化器走索引。
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_posts_pub_date
  ON posts (COALESCE(status, 'published'), date DESC, COALESCE(pinned, 0) DESC);

-- 标签页 / 分类页：按日期倒序再过滤，同样缺索引
CREATE INDEX IF NOT EXISTS idx_posts_date_desc ON posts (date DESC);

-- 评论按文章 + 状态取（文章页评论列表、热门统计）
CREATE INDEX IF NOT EXISTS idx_comments_post_status ON comments (post_id, status, date DESC);
