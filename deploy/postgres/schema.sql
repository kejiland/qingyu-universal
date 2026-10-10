-- ============================================================
-- 轻语博客 · PostgreSQL 架构
-- 由 SQLite migrations 0001-0039 等价转换而来（须保持幂等，每次启动重跑）。
-- 说明：comments.post_id 不再强绑 posts，以支持 gb-note / gb-idea 留言板；
-- 删除文章时由 trigger 清理评论。全文检索使用生成列 + GIN，替代 SQLite FTS5。
-- ============================================================

CREATE TABLE IF NOT EXISTS posts (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  date          TEXT DEFAULT '',
  excerpt       TEXT DEFAULT '',
  content       TEXT DEFAULT '',
  cover         TEXT DEFAULT '',
  pinned        INTEGER DEFAULT 0,
  protected     INTEGER DEFAULT 0,
  enc           TEXT,
  tags          TEXT,
  created_at    TEXT DEFAULT '',
  updated_at    TEXT DEFAULT '',
  category      TEXT DEFAULT '',
  status        TEXT DEFAULT 'published',
  publish_at    BIGINT,
  series        TEXT DEFAULT '',
  series_order  INTEGER DEFAULT 0,
  og_image      TEXT DEFAULT '',
  seo           TEXT DEFAULT '',
  author        TEXT DEFAULT '',
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(excerpt, '') || ' ' || coalesce(content, '') || ' ' || coalesce(tags, ''))
  ) STORED
);
CREATE INDEX IF NOT EXISTS idx_posts_series ON posts(series, series_order);
CREATE INDEX IF NOT EXISTS idx_posts_scheduled ON posts(publish_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_posts_search ON posts USING GIN(search_vector);
-- 0038：列表热路径索引（SSR 首页 / 归档 / 标签 / 分类共用的谓词与排序）
CREATE INDEX IF NOT EXISTS idx_posts_pub_date
  ON posts (COALESCE(status, 'published'), date DESC, COALESCE(pinned, 0) DESC);
CREATE INDEX IF NOT EXISTS idx_posts_date_desc ON posts (date DESC);

CREATE TABLE IF NOT EXISTS comments (
  seq       BIGSERIAL UNIQUE,
  id        TEXT PRIMARY KEY,
  post_id   TEXT NOT NULL,
  author    TEXT DEFAULT '',
  content   TEXT DEFAULT '',
  date      TEXT DEFAULT '',
  status    TEXT DEFAULT 'approved',
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  likes     INTEGER DEFAULT 0,
  featured  INTEGER DEFAULT 0,
  pinned    INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
-- 0038：文章页评论按文章 + 状态取
CREATE INDEX IF NOT EXISTS idx_comments_post_status ON comments (post_id, status, date DESC);
CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id, id);
CREATE INDEX IF NOT EXISTS idx_comments_status_date ON comments(status, date);

CREATE TABLE IF NOT EXISTS stats (
  post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  likes   INTEGER DEFAULT 0,
  views   INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS admin_auth (
  k           TEXT PRIMARY KEY,
  salt        TEXT DEFAULT '',
  hash        TEXT DEFAULT '',
  iter        INTEGER DEFAULT 100000,
  must_change INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  exp   BIGINT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_exp ON admin_sessions(exp);

CREATE TABLE IF NOT EXISTS admin_fails (
  ip    TEXT PRIMARY KEY,
  n     INTEGER DEFAULT 0,
  until BIGINT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS site_files (
  name       TEXT PRIMARY KEY,
  content    TEXT DEFAULT '',
  updated_at TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS site_settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- AI 助手配置：单独成表，不走公开的 /api/settings（那里含 API Key 会泄露）
CREATE TABLE IF NOT EXISTS ai_config (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- 对象存储配置：同上，含 S3 Secret Access Key，不能放进公开可读的 site_settings
CREATE TABLE IF NOT EXISTS storage_config (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stats_daily (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  date    TEXT NOT NULL,
  views   INTEGER DEFAULT 0,
  likes   INTEGER DEFAULT 0,
  PRIMARY KEY (post_id, date)
);
CREATE INDEX IF NOT EXISTS idx_stats_daily_date ON stats_daily(date);

CREATE TABLE IF NOT EXISTS media (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,
  type       TEXT DEFAULT '',
  size       INTEGER DEFAULT 0,
  created_at TEXT DEFAULT '',
  thumb_url  TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_media_created ON media(created_at);
CREATE INDEX IF NOT EXISTS idx_media_created_id ON media(created_at, id);

CREATE TABLE IF NOT EXISTS music (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  artist     TEXT DEFAULT '',
  url        TEXT NOT NULL,
  cover      TEXT DEFAULT '',
  size       INTEGER DEFAULT 0,
  duration   INTEGER DEFAULT 0,
  sort       INTEGER DEFAULT 0,
  created_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_music_sort ON music(sort, created_at);

CREATE TABLE IF NOT EXISTS post_revisions (
  id           BIGSERIAL PRIMARY KEY,
  post_id      TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  title        TEXT NOT NULL DEFAULT '',
  date         TEXT NOT NULL DEFAULT '',
  excerpt      TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL DEFAULT '',
  cover        TEXT NOT NULL DEFAULT '',
  pinned       INTEGER NOT NULL DEFAULT 0,
  protected    INTEGER NOT NULL DEFAULT 0,
  enc          TEXT,
  tags         TEXT NOT NULL DEFAULT '[]',
  category     TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'published',
  publish_at   BIGINT,
  reason       TEXT NOT NULL DEFAULT 'save',
  created_at   BIGINT NOT NULL,
  series       TEXT DEFAULT '',
  series_order INTEGER DEFAULT 0,
  og_image     TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_post_revisions_post_created ON post_revisions(post_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS backups (
  id         TEXT PRIMARY KEY,
  object_key TEXT NOT NULL,
  size       INTEGER DEFAULT 0,
  reason     TEXT DEFAULT 'manual',
  created_at BIGINT NOT NULL,
  counts     TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_backups_created ON backups(created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS subscribers (
  id               TEXT PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL DEFAULT 'pending',
  token            TEXT NOT NULL UNIQUE,
  locale           TEXT DEFAULT 'zh-CN',
  created_at       BIGINT NOT NULL,
  confirmed_at     BIGINT,
  unsubscribed_at  BIGINT,
  last_notified_at BIGINT,
  groups           TEXT DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(status, created_at DESC);

CREATE TABLE IF NOT EXISTS mail_outbox (
  id         BIGSERIAL PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  to_email   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT DEFAULT '',
  created_at BIGINT NOT NULL,
  sent_at    BIGINT,
  kind       TEXT DEFAULT 'post',
  payload    TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_mail_outbox_pending ON mail_outbox(status, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  action     TEXT NOT NULL,
  target     TEXT DEFAULT '',
  detail     TEXT DEFAULT '',
  ip         TEXT DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS stats_sources (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  date    TEXT NOT NULL,
  kind    TEXT NOT NULL,
  name    TEXT NOT NULL,
  views   INTEGER DEFAULT 0,
  PRIMARY KEY (post_id, date, kind, name)
);
CREATE INDEX IF NOT EXISTS idx_stats_sources_date ON stats_sources(date);

CREATE TABLE IF NOT EXISTS error_logs (
  id          BIGSERIAL PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'error',
  message     TEXT NOT NULL DEFAULT '',
  source      TEXT DEFAULT '',
  stack       TEXT DEFAULT '',
  url         TEXT DEFAULT '',
  ua          TEXT DEFAULT '',
  hits        INTEGER NOT NULL DEFAULT 1,
  created_at  BIGINT NOT NULL,
  last_at     BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_error_logs_fp ON error_logs(fingerprint);
CREATE INDEX IF NOT EXISTS idx_error_logs_last ON error_logs(last_at DESC);

CREATE TABLE IF NOT EXISTS webmentions (
  id          BIGSERIAL PRIMARY KEY,
  source      TEXT NOT NULL,
  target      TEXT NOT NULL,
  post_id     TEXT REFERENCES posts(id) ON DELETE CASCADE,
  author_name TEXT DEFAULT '',
  author_url  TEXT DEFAULT '',
  title       TEXT DEFAULT '',
  excerpt     TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'approved',
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webmentions_src_tgt ON webmentions(source, target);
CREATE INDEX IF NOT EXISTS idx_webmentions_target ON webmentions(target, created_at DESC);

CREATE TABLE IF NOT EXISTS _migrations (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS _kv_store (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  expires_at BIGINT
);

CREATE OR REPLACE FUNCTION qingyu_cleanup_comments_on_post_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM comments WHERE post_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_comments_cleanup_on_post_delete ON posts;
CREATE TRIGGER trg_comments_cleanup_on_post_delete
AFTER DELETE ON posts
FOR EACH ROW EXECUTE FUNCTION qingyu_cleanup_comments_on_post_delete();
-- ============================================================
-- 0039：回填 posts.created_at / updated_at
-- ------------------------------------------------------------
-- 写路径长期只在 SQLite migrations 里追加，PG 端首装后不再执行，
-- 这条因此长期缺失；api-core.js 已同步修复写路径，此处负责老数据。
-- 幂等（WHERE 过滤），每次启动随 schema.sql 重跑也安全。
-- ============================================================
UPDATE posts SET created_at = date WHERE created_at IS NULL OR created_at = '';
UPDATE posts SET updated_at = date WHERE updated_at IS NULL OR updated_at = '';
