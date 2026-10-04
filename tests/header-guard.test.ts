import { describe, expect, it } from 'vitest';
import { asciiHeaderValue, withAsciiHeaders } from '../src/header-guard.js';

describe('HTTP 头值兜底', () => {
  it('ASCII 头值原样返回（零改动）', () => {
    const v = 'W/"abc123"';
    expect(asciiHeaderValue(v)).toBe(v);
  });

  it('中文被百分号编码为纯 ASCII', () => {
    const out = asciiHeaderValue('posts,post:中文标题');
    expect(out).toBe('posts,post:%E4%B8%AD%E6%96%87%E6%A0%87%E9%A2%98');
    expect(/^[\x20-\x7E\t]*$/.test(out)).toBe(true);
  });

  it('emoji 按码点编码（不产生孤立代理项）', () => {
    // 若按下标遍历，emoji 会被拆成孤立代理项，encodeURIComponent 抛 URIError
    const out = asciiHeaderValue('emoji-🎉-end');
    expect(out).toBe('emoji-%F0%9F%8E%89-end');
    expect(() => asciiHeaderValue('🎉🎉🎉')).not.toThrow();
    expect(/^[\x20-\x7E\t]*$/.test(asciiHeaderValue('🎉🎉🎉'))).toBe(true);
  });

  it('保留 tab，编码控制字符', () => {
    expect(asciiHeaderValue('a\tb')).toBe('a\tb');
    expect(asciiHeaderValue('a\u0001b')).toBe('a%01b');
  });

  it('withAsciiHeaders 对全 ASCII 响应原样返回（不做多余重建）', async () => {
    const res = new Response('x', { headers: { ETag: 'W/"abc"' } });
    const out = await withAsciiHeaders(res);
    expect(out).toBe(res);
  });

  it('withAsciiHeaders 保留状态码与响应体', async () => {
    const res = new Response('hello', { status: 201, headers: { 'Cache-Tag': 'posts,post:%E4%B8%AD' } });
    const out = await withAsciiHeaders(res);
    expect(out.status).toBe(201);
    expect(await out.text()).toBe('hello');
  });
});
