-- ============================================================
-- comments.parent_id 自引用外键
-- ------------------------------------------------------------
-- 背景：删父评论时上游只执行 DELETE FROM comments WHERE id = ?，
-- 子回复不会被清理，parent_id 变成指向不存在评论的孤儿。
-- 而 handleComments 的 GET 会把「找不到父级」的评论提升为顶层显示，
-- 于是「删除一条评论」会把它的回复变成散落在顶层的评论。
--
-- 难点：SQLite 不支持 ADD CONSTRAINT，只能重建表；而这张表**自引用**。
-- 重建过程中的顺序是：
--   建 comments_new（外键写 REFERENCES comments）→ 复制 → 删旧表 → 改名
-- 两个 pragma 缺一不可：
--   foreign_keys=OFF     —— 否则 DROP TABLE comments 的隐式 DELETE
--                           会顺着 comments_new 的外键把刚复制进去的行级联删掉
--   legacy_alter_table=ON —— 否则 RENAME 会按新规则改写引用，
--                           自引用会指错对象
-- 见本文件顶部的 @foreign-keys-off 指令（迁移器会同时设置两者）。
-- ============================================================
-- @foreign-keys-off

-- 1. 清理存量孤儿：把指向不存在父级的回复提升为顶层（等价于当前显示行为，不丢内容）
UPDATE comments
   SET parent_id = NULL
 WHERE parent_id IS NOT NULL
   AND parent_id NOT IN (SELECT id FROM comments);

-- 2. 重建：同时保留 0033 加上的 post_id 外键，并新增 parent_id 外键
CREATE TABLE comments_new (
  id       TEXT PRIMARY KEY,
  post_id  TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
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

-- 3. 重建原有索引
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id, id);
CREATE INDEX IF NOT EXISTS idx_comments_status_date ON comments(status, date);