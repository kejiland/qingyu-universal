import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

const KEYS = [
  'QINGYU_ENV_FILE', 'PORT', 'HOST', 'SITE_URL', 'SITE_DOMAIN', 'DATA_DIR', 'TRUST_PROXY',
  'S3_ENDPOINT', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY',
  'S3_MEDIA_BUCKET', 'S3_MEDIA_PUBLIC_BASE', 'SMTP_HOST', 'BLOG_MAIL_FROM',
  'AI_BASE_URL', 'AI_MODEL', 'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
  'BLOG_ADMIN_SETUP_KEY', 'BLOG_PREVIEW_SECRET', 'CRON_TIMEZONE', 'BACKUP_CRON'
];

let dir: string;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-config-'));
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    Reflect.deleteProperty(process.env, key);
  }
  // 指向一个不存在的 .env，避免测试读取开发者本地的真实配置
  process.env.QINGYU_ENV_FILE = path.join(dir, 'missing.env');
  process.env.DATA_DIR = dir;
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('配置加载', () => {
  it('空环境下使用安全默认值', () => {
    const config = loadConfig();
    expect(config.port).toBe(8787);
    expect(config.host).toBe('127.0.0.1');
    expect(config.siteUrl).toBe('http://localhost:8787');
    expect(config.storageMode).toBe('local');
    // 安全默认：不信任 X-Forwarded-For。直连暴露时若默认信任，客户端伪造该头
    // 就能绕过登录失败锁定、评论频控、点赞去重。有反代才显式设 TRUST_PROXY=1。
    expect(config.trustProxy).toBe(false);
    expect(config.dbPath).toBe(path.join(dir, 'qingyu.db'));
    expect(config.cron.timezone).toBe('UTC');
    expect(config.cron.backup).toBe('0 19 * * *');
  });

  it('SITE_URL 去掉末尾斜杠', () => {
    process.env.SITE_URL = 'https://blog.example.com///';
    expect(loadConfig().siteUrl).toBe('https://blog.example.com');
  });

  it('TRUST_PROXY=0 关闭代理信任', () => {
    process.env.TRUST_PROXY = '0';
    expect(loadConfig().trustProxy).toBe(false);
  });

  it('S3 凭据齐全时切换到 s3 模式', () => {
    process.env.S3_ENDPOINT = 'https://minio.example.com';
    process.env.S3_ACCESS_KEY_ID = 'key';
    process.env.S3_SECRET_ACCESS_KEY = 'secret';
    process.env.S3_MEDIA_BUCKET = 'media';
    process.env.S3_REGION = 'us-east-1';
    const config = loadConfig();
    expect(config.storageMode).toBe('s3');
    expect(config.s3.region).toBe('us-east-1');
    expect(config.s3.mediaBucket).toBe('media');
  });

  it('兼容 Cloudflare 版变量名（R2_*）', () => {
    process.env.R2_ENDPOINT = 'https://r2.example.com';
    process.env.R2_ACCESS_KEY_ID = 'key';
    process.env.R2_SECRET_ACCESS_KEY = 'secret';
    process.env.R2_MEDIA_BUCKET = 'qingyu-media';
    const config = loadConfig();
    expect(config.storageMode).toBe('s3');
    expect(config.s3.mediaBucket).toBe('qingyu-media');
  });

  it('凭据不完整时回落到本地磁盘', () => {
    process.env.S3_ENDPOINT = 'https://minio.example.com';
    expect(loadConfig().storageMode).toBe('local');
  });

  it('本地密钥持久化：多次加载保持一致', () => {
    const first = loadConfig().secret;
    const second = loadConfig().secret;
    expect(first).toBe(second);
    expect(fs.existsSync(path.join(dir, '.secret'))).toBe(true);
  });

  it('非法端口在启动阶段就报错', () => {
    process.env.PORT = '70000';
    expect(() => loadConfig()).toThrow(/配置校验失败/);
  });
});