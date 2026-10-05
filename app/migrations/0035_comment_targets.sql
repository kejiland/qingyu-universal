-- ============================================================
-- 评论目标：允许文章与内置留言板并存
-- ------------------------------------------------------------
-- 留言板复用评论接口，但目标 ID 是 gb-note / gb-idea，并不对应
-- posts 表中的文章。0033 加的 comments.post_id → posts 外键会让
-- 留言板提交直接触发 FOREIGN KEY constraint failed（500）。
--
-- 这里重建 comments，仅保留 parent_id 自引用外键；普通文章评论
-- 由 API 层先校验文章存在，删除文章则由触发器清理整棵评论树。
-- 这样既支持留言板，又不把“删文章留下孤儿评论”的旧问题带回来。
-- ============================================================
-- @foreign-keys-off

CREATE TABLE comments_new (
  id       TEXT PRIMARY KEY,
  post_id  TEXT NOT NULL,
  author   TEXT DEFAULT '',
  content  TEXT DEFAULT '',
  date     TEXT DEFAULT '',
  status   TEXT DEFAULT 'approved',
  parent_id TEXT DEFAULT NULL REFERENCES comments(id) ON DELETE CASCADE,
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

CREATE TRIGGER IF NOT EXISTS trg_comments_cleanup_on_post_delete
AFTER DELETE ON posts
BEGIN
  DELETE FROM comments WHERE post_id = OLD.id;
END;
