-- ============================================================
-- AI 助手配置（后台「设置 → AI 助手」持久化）
-- ------------------------------------------------------------
-- 为什么不复用 site_settings？
--   /api/settings 是**公开 GET**（匿名可读，还带 Cache-Control: READ_CACHE 缓存），
--   而 AI 配置里含 API Key。放进 site_settings 等于把密钥公开广播出去。
--   因此这里单独建表，只由需要管理员会话的 /api/admin/ai 读写。
--
-- 键（均为 JSON 字符串或原始字符串值）：
--   enabled          '1' / '0'     总开关（关闭时 aiEnabled() 为 false，全站隐藏 AI）
--   publicGenerate   '1' / '0'     匿名访客是否可触发生成（消耗额度）
--   baseUrl          OpenAI 兼容根地址，如 https://api.example.com/v1
--   apiKey           Bearer 密钥（读取接口只返回打码值，不回传明文）
--   model            默认模型名，如 deepseek-v4-flash
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_config (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
