-- ============================================================
-- AI 配置：让后台可以改网关地址 / 模型 / Key，改完立即生效
-- ------------------------------------------------------------
-- 上游（Cloudflare 版）的 AI 是平台绑定 env.AI，没有「地址 / Key /
-- 模型」这三个概念，后台也就没有对应的设置项。自托管版要接第三方
-- OpenAI 兼容网关，就只能自己加一套配置。
--
-- 为什么不塞进 site_settings：
--   1）site_settings 的合法键是上游定义的那 10 个，
--      tests/ssr-settings-keys.test.ts 对键清单有精确断言，多一个就红；
--   2）API Key 属于凭据，和「站点标题 / 友链」这类展示型配置混在一张表里，
--      导出备份、静态站导出时容易被一起带出去。
-- 所以单独建表，约定只有一行（id = 1）。
--
-- 字段留空的语义：空字符串表示「沿用 .env 里的值」，
-- 这样后台什么都不填也不会把已经在跑的配置清空。
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_settings (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  base_url       TEXT    DEFAULT '',
  api_key        TEXT    DEFAULT '',
  model          TEXT    DEFAULT '',
  timeout_ms     INTEGER DEFAULT 0,
  max_retries    INTEGER DEFAULT -1,
  enabled        INTEGER DEFAULT -1,
  public_enabled INTEGER DEFAULT -1,
  updated_at     TEXT    DEFAULT ''
);
