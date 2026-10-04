-- ============================================================
-- 外键约束：补齐 26 张表之间缺失的引用完整性
-- ------------------------------------------------------------
-- 背景：全库原本零外键。上游删文章时只手工删除 comments 与 stats，
-- post_revisions / stats_daily / stats_sources / webmentions / mail_outbox
-- 都会残留成孤儿（本库迁移前已有 18 条孤儿 post_revisions）。
--
-- SQLite 不支持 ALTER TABLE ADD CONSTRAINT，只能按官方「12 步」重建表：
--   建新表（带 FK）→ 复制数据 → 删旧表 → 改名 → 重建索引
-- 因此本文件用 @foreign-keys-off 指令让迁移器在事务外关闭外键检查。
--
-- 引用方向都指向 posts（父表本身不重建），因此不存在自引用改名的坑。
-- ============================================================
-- @foreign-keys-off

-- ---------- 1. 先清理存量孤儿（否则新表插入时会违反外键） ----------
DELETE FROM comments      WHERE post_id NOT IN (SELECT id FROM posts);
DELETE FROM stats         WHERE post_id NOT IN (SELECT id FROM posts);
DELETE FROM stats_daily   WHERE post_id NOT IN (SELECT id FROM posts);
DELETE FROM stats_sources WHERE post_id NOT IN (SELECT id FROM posts);
DELETE FROM post_revisions WHERE post_id NOT IN (SELECT id FROM posts);
DELETE FROM mail_outbox   WHERE post_id NOT IN (SELECT id FROM posts);
-- webmentions 的 post_id 是「可选」的（默认空串），空串转成 NULL 才能过外键
UPDATE webmentions SET post_id = NULL WHERE post_id = '' OR post_id IS NULL;
DELETE FROM webmentions   WHERE post_id IS NOT NULL AND post_id NOT IN (SELECT id FROM posts);

-- ---------- 2. comments ----------
CREATE TABLE comments_new (
  id       TEXT PRIMARY KEY,
  post_id  TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author   TEXT DEFAULT '',
  content  TEXT DEFAULT '',
  date     TEXT DEFAULT '',
  status   TEXT DEFAULT 'approved',
  parent_id TEXT DEFAULT NULL,
  likes    INTEGER DEFAULT 0,
  featured INTEGER DEFAULT 0,
  pinned   INTEGER DEFAULT 0
);
INSERT INTO comments_new (id,post_id,author,content,date,status,parent_id,likes,featured,pinned)
  SELECT id,post_id,author,content,date,status,parent_id,likes,featured,pinned FROM comments;
DROP TABLE comments;
ALTER TABLE comments_new RENAME TO comments;
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id, id);
CREATE INDEX IF NOT EXISTS idx_comments_status_date ON comments(status, date);

-- ---------- 3. stats ----------
CREATE TABLE stats_new (
  post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  likes   INTEGER DEFAULT 0,
  views   INTEGER DEFAULT 0
);
INSERT INTO stats_new (post_id,likes,views) SELECT post_id,likes,views FROM stats;
DROP TABLE stats;
ALTER TABLE stats_new RENAME TO stats;

-- ---------- 4. stats_daily ----------
CREATE TABLE stats_daily_new (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  date    TEXT NOT NULL,
  views   INTEGER DEFAULT 0,
  likes   INTEGER DEFAULT 0,
  PRIMARY KEY (post_id, date)
);
INSERT INTO stats_daily_new (post_id,date,views,likes) SELECT post_id,date,views,likes FROM stats_daily;
DROP TABLE stats_daily;
ALTER TABLE stats_daily_new RENAME TO stats_daily;
CREATE INDEX IF NOT EXISTS idx_stats_daily_date ON stats_daily(date);

-- ---------- 5. stats_sources ----------
CREATE TABLE stats_sources_new (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  date    TEXT NOT NULL,
  kind    TEXT NOT NULL,
  name    TEXT NOT NULL,
  views   INTEGER DEFAULT 0,
  PRIMARY KEY (post_id, date, kind, name)
);
INSERT INTO stats_sources_new (post_id,date,kind,name,views)
  SELECT post_id,date,kind,name,views FROM stats_sources;
DROP TABLE stats_sources;
ALTER TABLE stats_sources_new RENAME TO stats_sources;
CREATE INDEX IF NOT EXISTS idx_stats_sources_date ON stats_sources(date);

-- ---------- 6. post_revisions ----------
-- 这是孤儿的重灾区：上游删文章时完全没清理它
CREATE TABLE post_revisions_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '',
  date        TEXT NOT NULL DEFAULT '',
  excerpt     TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  cover       TEXT NOT NULL DEFAULT '',
  pinned      INTEGER NOT NULL DEFAULT 0,
  protected   INTEGER NOT NULL DEFAULT 0,
  enc         TEXT,
  tags        TEXT NOT NULL DEFAULT '[]',
  category    TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'published',
  publish_at  INTEGER,
  reason      TEXT NOT NULL DEFAULT 'save',
  created_at  INTEGER NOT NULL,
  series      TEXT DEFAULT '',
  series_order INTEGER DEFAULT 0,
  og_image    TEXT DEFAULT ''
);
INSERT INTO post_revisions_new (id,post_id,title,date,excerpt,content,cover,pinned,protected,enc,tags,category,status,publish_at,reason,created_at,series,series_order,og_image)
  SELECT id,post_id,title,date,excerpt,content,cover,pinned,protected,enc,tags,category,status,publish_at,reason,created_at,series,series_order,og_image FROM post_revisions;
DROP TABLE post_revisions;
ALTER TABLE post_revisions_new RENAME TO post_revisions;
CREATE INDEX IF NOT EXISTS idx_post_revisions_post_created ON post_revisions(post_id, created_at DESC, id DESC);

-- ---------- 7. webmentions ----------
CREATE TABLE webmentions_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  target      TEXT NOT NULL,
  post_id     TEXT DEFAULT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_name TEXT DEFAULT '',
  author_url  TEXT DEFAULT '',
  title       TEXT DEFAULT '',
  excerpt     TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'approved',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
INSERT INTO webmentions_new (id,source,target,post_id,author_name,author_url,title,excerpt,status,created_at,updated_at)
  SELECT id,source,target,post_id,author_name,author_url,title,excerpt,status,created_at,updated_at FROM webmentions;
DROP TABLE webmentions;
ALTER TABLE webmentions_new RENAME TO webmentions;
CREATE UNIQUE INDEX IF NOT EXISTS idx_webmentions_src_tgt ON webmentions(source, target);
CREATE INDEX IF NOT EXISTS idx_webmentions_target ON webmentions(target, created_at DESC);

-- ---------- 8. mail_outbox ----------
CREATE TABLE mail_outbox_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  to_email   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  sent_at    INTEGER,
  kind       TEXT DEFAULT 'post',
  payload    TEXT DEFAULT ''
);
INSERT INTO mail_outbox_new (id,post_id,to_email,status,attempts,error,created_at,sent_at,kind,payload)
  SELECT id,post_id,to_email,status,attempts,error,created_at,sent_at,kind,payload FROM mail_outbox;
DROP TABLE mail_outbox;
ALTER TABLE mail_outbox_new RENAME TO mail_outbox;
CREATE INDEX IF NOT EXISTS idx_mail_outbox_pending ON mail_outbox(status, created_at);