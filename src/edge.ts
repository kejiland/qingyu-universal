/* ============================================================
 * 边缘信息注入
 * ------------------------------------------------------------
 * 上游只信任 CDN 注入的 CF-Connecting-IP（不读 X-Forwarded-For，因为该头
 * 客户端可伪造）。本进程就是可信边界，因此在这里统一注入，使限流 / 点赞去重 /
 * 来源统计拿到稳定的客户端标识。
 *
 * 契约层与 catch-all 兜底路径共用本实现，保证两条路径行为一致。
 * ============================================================ */
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import type { AppConfig } from './config.js';

type Ctx = Parameters<typeof getConnInfo>[0];

/** 解析真实客户端 IP：信任反代时读转发头，否则回落到 socket 地址。 */
export function resolveClientIp(c: Ctx, config: AppConfig): string {
  const header = (name: string): string => (c.req.header(name) ?? '').trim();

  if (config.trustProxy) {
    const forwarded = header('x-forwarded-for');
    if (forwarded) {
      const first = forwarded.split(',')[0]?.trim();
      if (first) return first;
    }
    const realIp = header('x-real-ip');
    if (realIp) return realIp;
  }

  try {
    return getConnInfo(c).remote.address ?? '';
  } catch {
    return '';
  }
}

/** 生成带上 CF-* 信息的请求（保留原始请求体与全部原始头）。 */
export function withEdgeHeaders(c: Ctx, config: AppConfig): Request {
  const original = c.req.raw;
  const headers = new Headers(original.headers);

  const ip = resolveClientIp(c, config);
  if (ip) headers.set('CF-Connecting-IP', ip);

  // 可选地理统计：反代注入国家码（Caddy + GeoIP2 / Nginx geoip2）。
  const geoHeader = config.geoipHeader.toLowerCase();
  const country = geoHeader ? (headers.get(geoHeader) ?? '').trim().toUpperCase().slice(0, 2) : '';
  if (country) headers.set('CF-IPCountry', country);

  const hasBody = original.method !== 'GET' && original.method !== 'HEAD' && original.body !== null;
  const init = {
    method: original.method,
    headers,
    ...(hasBody ? { body: original.body, duplex: 'half' } : {})
  } as RequestInit;

  const request = new Request(original.url, init);
  if (country) {
    try {
      Object.defineProperty(request, 'cf', { value: { country }, configurable: true });
    } catch {
      /* 只读环境下忽略：上游会回落到空国家码 */
    }
  }
  return request;
}