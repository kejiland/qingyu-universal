/* ============================================================
 * 域名与 HTTPS：纯校验 / .env 合并工具
 * ------------------------------------------------------------
 * 这里刻意不碰 Docker、网络或文件系统（除显式传入的 env 文件），
 * 便于单测覆盖「非法域名、DNS 不匹配、profiles 保留」等高风险规则。
 * ============================================================ */
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export interface DomainInput {
  primary: string;
  aliases?: string[];
}

export interface NormalizedDomains {
  primary: string;
  aliases: string[];
}

export class DomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainValidationError';
  }
}

/** 把用户输入规范成一个可写入 Caddy 的 ASCII 域名。 */
export function normalizeDomain(raw: string): string {
  let value = String(raw || '').trim().toLowerCase();
  value = value.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (value.includes('/') || value.includes('?') || value.includes('#')) {
    throw new DomainValidationError('域名不能包含路径、查询参数或片段');
  }
  value = value.replace(/\.$/, '');
  if (!value) throw new DomainValidationError('域名不能为空');
  if (isIP(value)) throw new DomainValidationError('不能使用 IP 地址作为域名');
  if (value === 'localhost' || value.endsWith('.localhost')) {
    throw new DomainValidationError('不能使用 localhost 作为对外域名');
  }
  if (value.includes('*') || value.includes('_')) {
    throw new DomainValidationError('不支持通配符或下划线域名');
  }
  const ascii = domainToASCII(value);
  if (!ascii) throw new DomainValidationError('域名格式无效');
  if (ascii.length > 253) throw new DomainValidationError('域名过长');
  const labels = ascii.split('.');
  if (labels.length < 2) throw new DomainValidationError('请输入带后缀的完整域名，例如 blog.example.com');
  for (const label of labels) {
    if (!label || label.length > 63) throw new DomainValidationError('域名标签长度不合法');
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)) {
      throw new DomainValidationError('域名标签只能包含字母、数字和连字符');
    }
  }
  return ascii;
}

export function normalizeDomains(input: DomainInput): NormalizedDomains {
  const primary = normalizeDomain(input.primary);
  const aliases: string[] = [];
  const seen = new Set([primary]);
  for (const raw of input.aliases || []) {
    const candidate = String(raw || '').trim();
    if (!candidate) continue;
    const alias = normalizeDomain(candidate);
    if (seen.has(alias)) throw new DomainValidationError(`域名重复：${alias}`);
    seen.add(alias);
    aliases.push(alias);
  }
  if (aliases.length > 20) throw new DomainValidationError('别名域名最多 20 个');
  return { primary, aliases };
}

export function canonicalDomain(value: string): string {
  return normalizeDomain(value);
}

export interface DnsLookupResult {
  addresses: string[];
}

export type DnsResolver = (hostname: string) => Promise<DnsLookupResult>;

export async function verifyDns(
  domains: NormalizedDomains,
  publicIp: string,
  resolver: DnsResolver
): Promise<{ ok: boolean; records: Array<{ domain: string; addresses: string[]; matches: boolean }>; error?: string }> {
  const expected = String(publicIp || '').trim();
  if (!expected || isIP(expected) === 0) {
    return { ok: false, records: [], error: '无法确定服务器公网 IP' };
  }
  const records = [];
  for (const domain of [domains.primary, ...domains.aliases]) {
    try {
      const result = await resolver(domain);
      const addresses = Array.from(new Set((result.addresses || []).map((x) => String(x).trim()).filter(Boolean)));
      records.push({ domain, addresses, matches: addresses.includes(expected) });
    } catch {
      // 解析失败和解析到错误地址一样，都必须在界面上明确显示为未通过。
      records.push({ domain, addresses: [], matches: false });
    }
  }
  const missing = records.filter((r) => !r.matches).map((r) => r.domain);
  return missing.length
    ? { ok: false, records, error: `DNS 尚未指向本机公网 IP：${missing.join('、')}` }
    : { ok: true, records };
}

export interface EnvEditOptions {
  enable: boolean;
  /** false = 关闭 HTTPS 但保留已保存的主域名和别名。 */
  clearDomains?: boolean;
  primary: string;
  aliases: string[];
  publicIp: string;
  appPort: number;
  currentProfiles: string;
}

/** 保留注释、未知变量和顺序；只替换已知键。 */
export function mergeEnvText(text: string, updates: Record<string, string>): string {
  const source = String(text || '').replace(/\r\n/g, '\n');
  const consumed = new Set<string>();
  const lines = source.split('\n').map((line) => {
    const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m) return line;
    const key = m[2]!;
    if (!(key in updates)) return line;
    consumed.add(key);
    return `${m[1]}${key}=${updates[key]}`;
  });
  const missing = Object.keys(updates).filter((key) => !consumed.has(key));
  if (missing.length) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    for (const key of missing) lines.push(`${key}=${updates[key]}`);
  }
  return lines.join('\n');
}

export function domainEnvUpdates(opts: EnvEditOptions): Record<string, string> {
  const profiles = new Set<string>();
  const currentProfiles = String(opts.currentProfiles || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  for (const p of currentProfiles) profiles.add(p);
  if (opts.enable) profiles.add('domain'); else profiles.delete('domain');
  const primary = opts.enable || !opts.clearDomains ? opts.primary : '';
  const aliases = opts.enable || !opts.clearDomains ? opts.aliases : [];
  return {
    COMPOSE_PROFILES: [...profiles].join(','),
    SITE_DOMAIN: primary,
    SITE_ALIASES: aliases.join(' '),
    SITE_URL: opts.enable ? `https://${opts.primary}` : `http://${opts.publicIp}:${opts.appPort}`,
    APP_BIND: opts.enable ? `127.0.0.1:${opts.appPort}` : `0.0.0.0:${opts.appPort}`,
    TRUST_PROXY: opts.enable ? '1' : '0'
  };
}
