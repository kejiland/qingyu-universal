-- 清理被移除的「导航菜单」配置模块遗留在 site_settings 的 nav 键值。
-- 后台「导航菜单设置」模块已移除（提交 c1ae714），前端不再读取/写入 nav；
-- 但历史上写入 D1 的 nav 数据未被同步清除，导致脏数据残留且无法通过界面修改。
-- DELETE 天然幂等，可随每次部署重复执行，直到该键值彻底不存在。
DELETE FROM site_settings WHERE k = 'nav';
