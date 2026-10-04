/* ============================================================
 * 内置定时任务调度器
 * ------------------------------------------------------------
 * 替代 Cloudflare Cron Triggers：
 *   · 每 5 分钟 —— 发布到点的定时文章 + 投递订阅邮件队列
 *   · 每天 19:00 UTC（北京时间 03:00）—— 自动备份
 * 单实例部署用进程内调度即可；多实例时用 INSTANCE_ID 只让一个实例执行，
 * 或改用外部 cron 调 POST /api/internal/cron（预留）。
 * ============================================================ */
export function startScheduler(worker, env, options) {
  const opts = options || {};
  const logger = opts.logger || console;
  const instanceId = String(opts.instanceId || '1');
  const intervalMs = Number(opts.tickMs || 60000);
  if (instanceId !== '1') {
    logger.log('[cron] 实例 ' + instanceId + ' 不启动内置调度（仅实例 1 负责）');
    return { stop() {} };
  }

  let lastFiveMinuteRun = 0;
  let lastDailyRun = '';

  async function invoke(cron) {
    try {
      await worker.scheduled({ cron: cron, scheduledTime: Date.now() }, env);
    } catch (error) {
      logger.error('[cron] 任务执行失败（' + cron + '）：' + (error && error.message));
    }
  }

  async function tick() {
    const now = Date.now();
    if (now - lastFiveMinuteRun >= 5 * 60 * 1000 - 5000) {
      lastFiveMinuteRun = now;
      await invoke('*/5 * * * *');
    }
    const date = new Date(now);
    const day = date.toISOString().slice(0, 10);
    if (date.getUTCHours() === 19 && date.getUTCMinutes() < 5 && lastDailyRun !== day) {
      lastDailyRun = day;
      await invoke('0 19 * * *');
    }
  }

  const timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
  timer.unref && timer.unref();
  // 启动后延迟 5 秒做一次「到点发布 + 邮件投递」，避免重启期间错过窗口。
  const kickoff = setTimeout(() => { tick().catch(() => {}); }, 5000);
  kickoff.unref && kickoff.unref();

  logger.log('[cron] 内置调度已启动（每 5 分钟发布/投递，每天 19:00 UTC 备份）');
  return {
    stop() { clearInterval(timer); clearTimeout(kickoff); }
  };
}