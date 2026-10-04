/* ============================================================
 * 定时任务：node-cron
 * ------------------------------------------------------------
 * 替代 Cloudflare Cron Triggers。上游 worker.scheduled() 用 event.cron
 * 区分任务，这里按同样的表达式触发，因此上游代码无需改动。
 *
 *   · 每 5 分钟 —— 发布到点的定时文章 + 投递订阅邮件队列
 *   · 每天 19:00 UTC（北京时间 03:00）—— 自动备份
 *
 * 多实例部署时用 INSTANCE_ID 指定只有一个实例启用调度（默认实例 1），
 * 避免重复发布/重复发信。
 * ============================================================ */
import cron, { type ScheduledTask } from 'node-cron';
import type { ScheduledEventLike, WorkerEnv, WorkerModule } from './types.js';

export const PUBLISH_CRON = '*/5 * * * *';

export interface SchedulerOptions {
  instanceId?: string;
  /** 备份任务表达式，默认与上游一致（每天 19:00 UTC）。 */
  backupCron?: string;
  /** Cron 时区，默认 UTC 以保持与 Cloudflare 行为一致。 */
  timezone?: string;
  logger?: { info: (msg: string) => void; error: (msg: string) => void };
}

export interface Scheduler {
  stop(): void;
  tasks: string[];
}

export function startScheduler(worker: WorkerModule, env: WorkerEnv, options: SchedulerOptions = {}): Scheduler {
  const log = options.logger ?? {
    info: (message: string) => console.log(message),
    error: (message: string) => console.error(message)
  };
  const timezone = options.timezone || 'UTC';
  const instanceId = String(options.instanceId ?? '1');
  const backupCron = options.backupCron || '0 19 * * *';

  if (instanceId !== '1') {
    log.info(`[cron] 实例 ${instanceId} 不启用内置调度（仅实例 1 负责）`);
    return { stop: () => {}, tasks: [] };
  }

  const invoke = async (expression: string): Promise<void> => {
    const event: ScheduledEventLike = { cron: expression, scheduledTime: Date.now() };
    try {
      await worker.scheduled(event, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`[cron] 任务执行失败（${expression}）：${message}`);
    }
  };

  const created: ScheduledTask[] = [];

  if (cron.validate(PUBLISH_CRON)) {
    created.push(cron.schedule(PUBLISH_CRON, () => void invoke(PUBLISH_CRON), { timezone }));
  } else {
    log.error(`[cron] 无效表达式：${PUBLISH_CRON}`);
  }

  if (cron.validate(backupCron)) {
    created.push(cron.schedule(backupCron, () => void invoke(backupCron), { timezone }));
  } else {
    log.error(`[cron] 无效的备份表达式：${backupCron}（已跳过自动备份）`);
  }

  // 启动后补跑一次：覆盖「服务重启期间正好到点」的窗口。
  const kickoff = setTimeout(() => void invoke(PUBLISH_CRON), 5000);
  kickoff.unref?.();

  log.info(`[cron] 调度已启动：发布/投递 ${PUBLISH_CRON}，自动备份 ${backupCron}（时区 ${timezone}）`);

  return {
    tasks: [PUBLISH_CRON, backupCron],
    stop() {
      clearTimeout(kickoff);
      for (const task of created) task.stop();
    }
  };
}