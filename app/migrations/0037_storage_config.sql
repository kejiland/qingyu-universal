-- ============================================================
-- 对象存储配置（后台「设置 → 存储」持久化）
-- ------------------------------------------------------------
-- 为什么不复用 site_settings？
--   与 ai_config 同理：/api/settings 是**公开 GET**（匿名可读且带缓存），
--   而这里含 S3 Secret Access Key。放进 site_settings 等于公开广播密钥。
--   因此单独建表，只由需要管理员会话的 /api/admin/storage 读写。
--
-- 键：
--   mode              'local' / 's3'   存储方式（缺省时跟随环境变量推断）
--   endpoint          S3 兼容端点，如 https://xxx.r2.cloudflarestorage.com
--   region            R2 固定 auto；MinIO 通常 us-east-1
--   accessKeyId       Access Key ID
--   secretAccessKey   Secret Access Key（读取接口只返回打码值，不回传明文）
--   mediaBucket       媒体桶名
--   mediaPublicBase   媒体桶公开域名（如 https://media.example.com）
--   musicBucket       音乐桶名（留空则回退媒体桶）
--   musicPublicBase   音乐桶公开域名（留空则回退媒体域名）
--   backupBucket      备份桶名
--
-- 生效方式：写入后立刻重建 storageRuntime，配合 worker-env 的动态 getter
--           **无需重启即生效**（与 ai_config 同一套机制）。
-- ============================================================
CREATE TABLE IF NOT EXISTS storage_config (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
