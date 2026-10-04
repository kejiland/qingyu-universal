/* ============================================================
 * 日志：pino
 * ------------------------------------------------------------
 * 自托管版把上游的 console.* 也接管进结构化日志，这样容器日志里
 * 「应用日志」和「框架日志」是一致格式，方便 Loki / journald 采集。
 * ============================================================ */
import { pino, type Logger } from 'pino';

const isProduction = process.env.NODE_ENV === 'production';
const usePretty = process.env.LOG_PRETTY === '1' || (!isProduction && process.env.LOG_PRETTY !== '0');

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  base: undefined, // 精简输出：不重复打印 pid/hostname
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(usePretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' }
        }
      }
    : {})
});

/**
 * 把上游 JS 代码的 console.* 转发到 pino。
 * 上游有大量 console.log/warn/error（缓存清理、Cron、D1 错误等），
 * 统一格式后排查线上问题会容易很多。
 */
export function bridgeConsole(target: Logger = logger): void {
  const forward =
    (level: 'info' | 'warn' | 'error' | 'debug') =>
    (...args: unknown[]): void => {
      const message = args
        .map((value) => {
          if (value instanceof Error) return value.stack || value.message;
          if (typeof value === 'string') return value;
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })
        .join(' ');
      target[level]({ source: 'app' }, message);
    };

  console.log = forward('info');
  console.info = forward('info');
  console.debug = forward('debug');
  console.warn = forward('warn');
  console.error = forward('error');
}