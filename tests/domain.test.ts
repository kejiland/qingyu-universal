import { describe, expect, it } from 'vitest';
import {
  DomainValidationError,
  domainEnvUpdates,
  mergeEnvText,
  normalizeDomain,
  normalizeDomains,
  verifyDns
} from '../src/domain/core.js';

describe('域名配置核心规则', () => {
  it('规范化协议、大小写和末尾点', () => {
    expect(normalizeDomain(' HTTPS://Blog.Example.com./ ')).toBe('blog.example.com');
  });

  it('拒绝 IP、localhost、通配符和重复别名', () => {
    expect(() => normalizeDomain('127.0.0.1')).toThrow(DomainValidationError);
    expect(() => normalizeDomain('localhost')).toThrow(DomainValidationError);
    expect(() => normalizeDomain('*.example.com')).toThrow(DomainValidationError);
    expect(() => normalizeDomains({ primary: 'blog.example.com', aliases: ['BLOG.EXAMPLE.COM'] }))
      .toThrow(/域名重复/);
  });

  it('DNS 必须全部指向本机，失败时保留每一条解析结果', async () => {
    const addresses: Record<string, string[]> = {
      'blog.example.com': ['203.0.113.10'],
      'www.example.com': ['203.0.113.11']
    };
    const result = await verifyDns(
      normalizeDomains({ primary: 'blog.example.com', aliases: ['www.example.com'] }),
      '203.0.113.10',
      async (hostname) => ({ addresses: addresses[hostname] || [] })
    );
    expect(result.ok).toBe(false);
    expect(result.records).toEqual([
      { domain: 'blog.example.com', addresses: ['203.0.113.10'], matches: true },
      { domain: 'www.example.com', addresses: ['203.0.113.11'], matches: false }
    ]);
    expect(result.error).toContain('www.example.com');
  });

  it('修改 .env 时保留注释、未知变量和顺序', () => {
    const input = [
      '# deployment',
      'UNKNOWN=keep-me',
      'SITE_DOMAIN=old.example.com',
      'APP_BIND=0.0.0.0:8080'
    ].join('\n');
    const output = mergeEnvText(input, {
      SITE_DOMAIN: 'new.example.com',
      APP_BIND: '127.0.0.1:8787',
      SITE_ALIASES: 'www.example.com'
    });
    expect(output).toContain('# deployment');
    expect(output).toContain('UNKNOWN=keep-me');
    expect(output).toContain('SITE_DOMAIN=new.example.com');
    expect(output).toContain('APP_BIND=127.0.0.1:8787');
    expect(output.endsWith('SITE_ALIASES=www.example.com')).toBe(true);
  });

  it('启用 HTTPS 保留已有 profile，关闭时可保留或清空域名', () => {
    const enabled = domainEnvUpdates({
      enable: true,
      primary: 'blog.example.com',
      aliases: ['www.example.com'],
      publicIp: '203.0.113.10',
      appPort: 9797,
      currentProfiles: 'postgres,redis'
    });
    expect(enabled.COMPOSE_PROFILES).toBe('postgres,redis,domain');
    expect(enabled.APP_BIND).toBe('127.0.0.1:9797');
    expect(enabled.SITE_URL).toBe('https://blog.example.com');
    expect(enabled.TRUST_PROXY).toBe('1');

    const disabled = domainEnvUpdates({
      enable: false,
      clearDomains: false,
      primary: 'blog.example.com',
      aliases: ['www.example.com'],
      publicIp: '203.0.113.10',
      appPort: 9797,
      currentProfiles: 'postgres,redis,domain'
    });
    expect(disabled.COMPOSE_PROFILES).toBe('postgres,redis');
    expect(disabled.SITE_DOMAIN).toBe('blog.example.com');
    expect(disabled.SITE_ALIASES).toBe('www.example.com');
    expect(disabled.SITE_URL).toBe('http://203.0.113.10:9797');

    const removed = domainEnvUpdates({
      enable: false,
      clearDomains: true,
      primary: 'blog.example.com',
      aliases: ['www.example.com'],
      publicIp: '203.0.113.10',
      appPort: 9797,
      currentProfiles: 'domain'
    });
    expect(removed.SITE_DOMAIN).toBe('');
    expect(removed.SITE_ALIASES).toBe('');
    expect(removed.APP_BIND).toBe('0.0.0.0:9797');
    expect(removed.TRUST_PROXY).toBe('0');
  });
});
