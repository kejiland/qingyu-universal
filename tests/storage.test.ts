import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalStorage, type LocalStorage } from '../src/bindings/storage.js';
import type { WorkerEnv } from '../src/types.js';

let dir: string;
let storage: LocalStorage;
const env = {} as WorkerEnv;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-storage-'));
  storage = createLocalStorage({ uploadDir: dir, secret: 'test-secret', baseUrl: 'https://blog.example.com' });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function paramsOf(url: string): URLSearchParams {
  return new URL(url, 'https://blog.example.com').searchParams;
}

describe('本地存储适配器', () => {
  it('presignPut 生成带签名与有效期的上传地址', async () => {
    const url = await storage.presignPut(env, 'media/a.png', 3600, 'media', 'image/png');
    expect(url.startsWith('https://blog.example.com/api/local-upload?')).toBe(true);

    const params = paramsOf(url);
    expect(params.get('key')).toBe('media/a.png');
    expect(params.get('ct')).toBe('image/png');
    expect(Number(params.get('exp'))).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(params.get('sig')).toBeTruthy();
  });

  it('浏览器上传可生成同源相对地址', async () => {
    const url = await storage.presignPut(env, 'media/c.png', 3600, 'media', 'image/png', true);
    expect(url.startsWith('/api/local-upload?')).toBe(true);
  });

  it('verify 接受合法签名、拒绝篡改与过期', async () => {
    const url = await storage.presignPut(env, 'media/b.png', 3600, 'media', 'image/png');
    const params = paramsOf(url);
    const key = params.get('key')!;
    const exp = params.get('exp')!;
    const ct = params.get('ct')!;
    const sig = params.get('sig')!;

    expect(storage.verify('PUT', key, exp, ct, sig)).toBe(true);
    // 篡改 key 后签名不再匹配
    expect(storage.verify('PUT', 'media/evil.png', exp, ct, sig)).toBe(false);
    // 过期地址被拒绝
    const expired = String(Math.floor(Date.now() / 1000) - 10);
    const expiredUrl = await storage.presignGet(env, 'backups/x.json', -1);
    const expiredParams = paramsOf(expiredUrl);
    expect(storage.verify('GET', 'backups/x.json', expiredParams.get('exp')!, '', expiredParams.get('sig')!)).toBe(false);
    expect(expired).toBeTruthy();
  });

  it('resolve 只接受白名单前缀，阻断目录穿越', () => {
    expect(storage.resolve('media/ok.png')).toBeTruthy();
    expect(storage.resolve('music/ok.mp3')).toBeTruthy();
    expect(storage.resolve('og/ok.png')).toBeTruthy();
    expect(storage.resolve('backups/dump.json')).toBeTruthy();

    expect(storage.resolve('../etc/passwd')).toBeNull();
    expect(storage.resolve('media/../../etc/passwd')).toBeNull();
    expect(storage.resolve('config/secret')).toBeNull();
    expect(storage.resolve('/absolute/path')).toBeNull();
    expect(storage.resolve('')).toBeNull();
  });

  it('resolvePublic 阻断越界路径', () => {
    expect(storage.resolvePublic('/media/a.png')).toBeTruthy();
    expect(storage.resolvePublic('/media/../../etc/passwd')).toBeNull();
  });

  it('deleteObject 只删除白名单内的对象', async () => {
    const target = storage.resolve('media/gone.png');
    fs.writeFileSync(target!, 'x');
    expect(fs.existsSync(target!)).toBe(true);
    expect(await storage.deleteObject(env, 'media/gone.png')).toBe(true);
    expect(fs.existsSync(target!)).toBe(false);
    expect(await storage.deleteObject(env, '../outside.txt')).toBe(false);
  });
});