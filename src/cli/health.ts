/* 容器 / 探针健康检查：非 200 或 ok=false 时退出码非 0。 */
import { loadConfig } from '../config.js';

const config = loadConfig();
const url = process.env.HEALTH_URL || `http://127.0.0.1:${config.port}/healthz`;

try {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    console.error(`unhealthy: HTTP ${response.status}`);
    process.exit(1);
  }
  const payload = (await response.json()) as { ok?: boolean };
  if (!payload.ok) {
    console.error(`unhealthy: ${JSON.stringify(payload)}`);
    process.exit(1);
  }
  console.log('healthy');
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`unhealthy: ${message}`);
  process.exit(1);
}