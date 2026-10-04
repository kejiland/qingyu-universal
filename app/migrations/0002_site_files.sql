-- 站点生成产物（feed.xml / sitemap.xml）：随文章发布/删除一同写入云端，供下载与备份
-- name 为主键（feed.xml / sitemap.xml），content 为最新生成的 XML 文本
CREATE TABLE IF NOT EXISTS site_files (
  name       TEXT PRIMARY KEY,
  content    TEXT DEFAULT '',
  updated_at TEXT DEFAULT ''
);
