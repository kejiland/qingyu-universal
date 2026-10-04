#!/usr/bin/env node
/* 容器健康检查：GET /healthz，非 200 退出码非 0（Docker HEALTHCHECK 用）。 */
const url = (process.env.HEALTH_URL || ('http://127.0.0.1:' + (process.env.PORT || 8787) + '/healthz'));
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) { console.error('unhealthy: HTTP ' + res.status); process.exit(1); }
  const data = await res.json();
  if (!data.ok) { console.error('unhealthy: ' + JSON.stringify(data)); process.exit(1); }
  console.log('healthy');
  process.exit(0);
} catch (error) {
  console.error('unhealthy: ' + error.message);
  process.exit(1);
}