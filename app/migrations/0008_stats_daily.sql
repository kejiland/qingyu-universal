-- 每日阅读/点赞聚合：用于后台「近 N 天访问趋势 / 点赞趋势」图表
-- 每次发生阅读或点赞时按 (post_id, date) 累加，避免逐条存储导致查询缓慢。
CREATE TABLE IF NOT EXISTS stats_daily (
  post_id TEXT NOT NULL,
  date    TEXT NOT NULL,
  views   INTEGER DEFAULT 0,
  likes   INTEGER DEFAULT 0,
  PRIMARY KEY (post_id, date)
);
CREATE INDEX IF NOT EXISTS idx_stats_daily_date ON stats_daily(date);
