-- 站点设置（键值对）：后台「博客设置」页面持久化配置
-- 例如站点名称、简介、头像、页脚版权、导航菜单、个人资料、评论审核开关等。
-- 仅存储 JSON 字符串值，读取端自行解析。
CREATE TABLE IF NOT EXISTS site_settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
