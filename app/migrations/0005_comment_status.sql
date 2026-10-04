-- 评论补充字段：审核状态(status)
-- 为已存在部署的 comments 表补列（deploy.yml 中做了列已存在即跳过处理）。
-- 新建数据库时 0001 不含 status 列，由此文件补齐。
-- 注意：此文件仅包含 ALTER（不可幂等），索引由 0009 单独创建。
ALTER TABLE comments ADD COLUMN status TEXT DEFAULT 'approved';
