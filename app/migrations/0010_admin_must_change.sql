-- 管理员认证：新增 must_change 字段
-- 首次自动初始化默认密码时标记为 1，登录后强制修改密码后清零。
ALTER TABLE admin_auth ADD COLUMN must_change INTEGER DEFAULT 0;
