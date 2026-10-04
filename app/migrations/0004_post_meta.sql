-- 文章补充字段：分类(category) 与 发布状态(status)
-- 为已存在部署的 posts 表补列（新部署已含于 0001_init.sql，此脚本幂等）。
-- SQLite 无 ADD COLUMN IF NOT EXISTS；重复执行会报 duplicate column，
-- deploy.yml 中对该脚本做了「列已存在即忽略」处理（与 0003 同源）。
ALTER TABLE posts ADD COLUMN category TEXT DEFAULT '';
ALTER TABLE posts ADD COLUMN status TEXT DEFAULT 'published';
