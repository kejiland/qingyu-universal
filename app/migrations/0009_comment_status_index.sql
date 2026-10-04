-- 评论审核状态索引（幂等：CREATE INDEX IF NOT EXISTS 可安全重复执行）。
-- 新建库由0005创建status列后建索引；老库可能缺索引，此文件补齐。
CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
