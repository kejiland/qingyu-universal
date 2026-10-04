-- 评论回复功能：添加 parent_id 字段
ALTER TABLE comments ADD COLUMN parent_id TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);