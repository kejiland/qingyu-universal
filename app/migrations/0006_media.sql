-- 媒体资源库（图片上传库）：后台「媒体库」页面使用
-- 图片以 data URL（base64）或外链 URL 存储；个人博客用量小，存 D1 即可。
CREATE TABLE IF NOT EXISTS media (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,        -- data URL 或外链 URL
  type        TEXT DEFAULT '',      -- MIME，如 image/png
  size        INTEGER DEFAULT 0,    -- 字节
  created_at  TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_media_created ON media(created_at);
