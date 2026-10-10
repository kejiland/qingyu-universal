-- ============================================================
-- 回填 posts.created_at / updated_at（0039）
-- ------------------------------------------------------------
-- 两列自 0001 就存在，但写路径（POST / PUT /api/posts）从未赋值，
-- 恒为空串。后果：sitemap 的 <lastmod>、文章页的 dateModified /
-- article:modified_time、各类缓存指纹全部失去依据 —— 改过十次的
-- 文章对搜索引擎仍是「发布即冻结」。
--
-- 无法精确恢复历史修改时间点，退而求其次：
--   · created_at 用 date（发布日期）—— 这是唯一已知的过去时间点
--   · updated_at 同样用 date —— 比「空」略保守，但至少是一个合法值
-- 这两条之后，新建/编辑的文章会带准确时间（api-core.js 已同步修复）。
-- ============================================================
UPDATE posts SET created_at = date WHERE created_at = '' OR created_at IS NULL;
UPDATE posts SET updated_at = date WHERE updated_at = '' OR updated_at IS NULL;
