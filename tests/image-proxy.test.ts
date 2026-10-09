import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configureImageProxy,
  hostOfUrl,
  imageProxyUrl,
  proxyHtmlImgSources,
  resetImageProxy,
  setImageWarmer,
  warmImageCache
} from '../src/lib/image-url.js';
import { createImageProxyHandler } from '../src/routes/image-proxy.js';
import { collectWarmableImages, postRoutes } from '../src/api/routes/posts.js';
import type { ApiContext } from '../src/api/registry.js';
import { renderHomeContent } from '../src/ssr/list.js';
import type { PostRow, SiteIdentity } from '../src/seo/meta.js';
import type { Context } from 'hono';

/* ------------------------------------------------------------
 * 这个测试守三件事：
 *   1. 地址改写规则（跨域改写、同源/相对/data: 不碰）；
 *   2. /api/img 的 SSRF 防护与缓存语义；
 *   3. SSR（TS）与前端（app.js 注入的 proxiedImg()）两套实现规则一致 ——
 *      两边不一致会让 SSR 与 SPA 接管后渲染出两个 URL，
 *      浏览器把同一张图各下一遍，优化直接白做。
 * ------------------------------------------------------------ */

const tempDirs: string[] = [];
async function tmpDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qingyu-imgproxy-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  resetImageProxy();
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/** 构造最小 Hono Context：只需要 query / header / method。 */
function ctx(url: string, init: { method?: string; headers?: Record<string, string> } = {}): Context {
  const parsed = new URL(url);
  const headers = new Headers(init.headers ?? {});
  return {
    req: {
      method: init.method ?? 'GET',
      url: parsed.toString(),
      query: (name: string) => parsed.searchParams.get(name) ?? undefined,
      header: (name: string) => headers.get(name) ?? undefined,
      raw: new Request(url, { method: init.method ?? 'GET', headers })
    },
    // 处理器用 c.text() 返回错误文案；这里补一个等价实现就够，不必拉起真实 Hono app
    text: (body: string, status: number, headers?: Record<string, string>) =>
      new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...(headers ?? {}) } })
  } as unknown as Context;
}

function imageResponse(body: Uint8Array, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

describe('imageProxyUrl —— 地址改写规则', () => {
  it('跨域 http(s) 图片改写成 /api/img?url=…', () => {
    expect(imageProxyUrl('https://images.example.com/a.webp')).toBe(
      '/api/img?url=' + encodeURIComponent('https://images.example.com/a.webp')
    );
    expect(imageProxyUrl('  http://cdn.test/x.png  ')).toBe('/api/img?url=' + encodeURIComponent('http://cdn.test/x.png'));
  });

  it('相对地址 / data: / blob: 原样返回（它们本来就是本站或内联数据）', () => {
    expect(imageProxyUrl('/media/a.png')).toBe('/media/a.png');
    expect(imageProxyUrl('data:image/svg+xml,<svg/>')).toBe('data:image/svg+xml,<svg/>');
    expect(imageProxyUrl('blob:http://x/y')).toBe('blob:http://x/y');
    expect(imageProxyUrl('')).toBe('');
  });

  it('与本站同域的绝对地址不反代', () => {
    configureImageProxy({ selfHost: 'blog.example.com' });
    expect(imageProxyUrl('https://blog.example.com/media/a.png')).toBe('https://blog.example.com/media/a.png');
    expect(imageProxyUrl('https://cdn.example.com/a.png')).toContain('/api/img?url=');
  });

  it('关闭反代时全部原样返回（与服务端 302 直通行为一致）', () => {
    configureImageProxy({ enabled: false });
    expect(imageProxyUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
  });

  it('hostOfUrl 对非法输入返回空串，不抛异常', () => {
    expect(hostOfUrl('not a url')).toBe('');
    expect(hostOfUrl('')).toBe('');
    expect(hostOfUrl('https://A.example.com:443/x')).toBe('a.example.com');
  });
});

describe('proxyHtmlImgSources —— 正文图片批量改写', () => {
  it('只改 <img src> 的跨域地址，不动同源与相对地址', () => {
    const html =
      '<img src="https://cdn.example.com/a.png" alt="x">' +
      "<img src='https://cdn.example.com/b.png'>" +
      '<img src="/media/c.png">' +
      '<a href="https://cdn.example.com/d.png">link</a>';
    const out = proxyHtmlImgSources(html);
    expect(out).toContain('/api/img?url=' + encodeURIComponent('https://cdn.example.com/a.png'));
    expect(out).toContain('/api/img?url=' + encodeURIComponent('https://cdn.example.com/b.png'));
    expect(out).toContain('src="/media/c.png"');
    // 链接不该被改写
    expect(out).toContain('href="https://cdn.example.com/d.png"');
  });
});

describe('/api/img —— SSRF 防护', () => {
  it('拒绝非 http(s) 协议', async () => {
    const handler = createImageProxyHandler({ cacheDir: await tmpDir() });
    for (const bad of ['file:///etc/passwd', 'gopher://x/', 'javascript:alert(1)']) {
      const res = await handler(ctx(`http://x/api/img?url=${encodeURIComponent(bad)}`));
      expect(res.status).toBe(400);
    }
  });

  it('拒绝环回 / 私有 / 链路本地 / 组播地址', async () => {
    const handler = createImageProxyHandler({ cacheDir: await tmpDir() });
    for (const bad of [
      'http://127.0.0.1/admin',
      'http://localhost:8787/api/settings',
      'http://10.0.0.5/x.png',
      'http://192.168.1.1/x.png',
      'http://172.16.0.1/x.png',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/x.png',
      'http://[::1]/x.png',
      'http://[fc00::1]/x.png',
      'https://224.0.0.1/x.png'
    ]) {
      const res = await handler(ctx(`http://x/api/img?url=${encodeURIComponent(bad)}`));
      expect(res.status, bad).toBe(403);
    }
  });

  it('不误伤 fake-IP DNS（198.18/15）—— Clash/Mihomo 默认段，实测会落到这里', async () => {
    const cacheDir = await tmpDir();
    let calls = 0;
    const impl = (async () => {
      calls++;
      return imageResponse(new Uint8Array(Buffer.from('png')), 'image/png');
    }) as unknown as typeof fetch;
    const handler = createImageProxyHandler({ cacheDir, fetchImpl: impl, resolve: async () => ['198.18.2.245'] });
    const res = await handler(ctx(`http://x/api/img?url=${encodeURIComponent('https://cdn.example.com/a.png')}`));
    // 若把 198.18/15 当成内网，这里会是 403，整个反代功能在 fake-IP 环境下直接失效
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  it('域名解析失败返回 502', async () => {
    const cacheDir = await tmpDir();
    const handler = createImageProxyHandler({
      cacheDir,
      fetchImpl: (async () => { throw new Error('不该发起请求'); }) as unknown as typeof fetch,
      resolve: async () => {
        throw new Error('ENOTFOUND');
      }
    });
    const res = await handler(ctx(`http://x/api/img?url=${encodeURIComponent('https://nope.example.com/a.png')}`));
    expect(res.status).toBe(502);
  });

  it('缺少 url 参数返回 400', async () => {
    const handler = createImageProxyHandler({ cacheDir: await tmpDir() });
    const res = await handler(ctx('http://x/api/img'));
    expect(res.status).toBe(400);
  });
});

describe('/api/img —— 抓取与缓存', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  /** 固定把任意域名解析成公网 IP：判定不依赖测试机真实 DNS（后者会漂移）。 */
  const publicDns = async () => ['93.184.216.34'];

  function handlerWith(cacheDir: string, impl: typeof fetch, extra: Partial<Parameters<typeof createImageProxyHandler>[0]> = {}) {
    return createImageProxyHandler({ cacheDir, fetchImpl: impl, resolve: publicDns, ...extra });
  }

  it('首次抓取并落盘，第二次命中磁盘缓存且不再请求源站', async () => {
    const cacheDir = await tmpDir();
    let calls = 0;
    const impl = (async () => {
      calls++;
      return imageResponse(new Uint8Array(png), 'image/png');
    }) as unknown as typeof fetch;

    const handler = handlerWith(cacheDir, impl);
    const url = 'https://cdn.example.com/cover.png';

    const first = await handler(ctx(`http://x/api/img?url=${encodeURIComponent(url)}`));
    expect(first.status).toBe(200);
    expect(first.headers.get('x-image-proxy')).toBe('miss');
    expect(first.headers.get('content-type')).toBe('image/png');
    expect(first.headers.get('cache-control')).toContain('immutable');
    await first.arrayBuffer();

    // 落盘是后台异步写的（先返回字节再写盘），这里必须等**文件**出现，
    // 不能只等分片目录 —— mkdir 早于 writeFile，等目录会读到空缓存。
    const key = createHash('sha256').update(url).digest('hex');
    const cached = path.join(cacheDir, key.slice(0, 2), key);
    for (let i = 0; i < 100 && !fs.existsSync(cached); i++) await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(cached)).toBe(true);
    expect(fs.readFileSync(`${cached}.meta`, 'utf8')).toBe('image/png');

    const second = await handler(ctx(`http://x/api/img?url=${encodeURIComponent(url)}`));
    expect(second.headers.get('x-image-proxy')).toBe('hit');
    expect(calls).toBe(1);
  });

  it('非图片响应返回 415，不会被缓存进目录', async () => {
    const cacheDir = await tmpDir();
    const impl = (async () => imageResponse(new Uint8Array(Buffer.from('<html>')), 'text/html')) as unknown as typeof fetch;
    const handler = handlerWith(cacheDir, impl);
    const res = await handler(ctx(`http://x/api/img?url=${encodeURIComponent('https://cdn.example.com/x')}`));
    expect(res.status).toBe(415);
  });

  it('超出单张上限返回 413', async () => {
    const cacheDir = await tmpDir();
    const big = Buffer.alloc(4096);
    const impl = (async () => imageResponse(new Uint8Array(big), 'image/png')) as unknown as typeof fetch;
    const handler = handlerWith(cacheDir, impl, { maxBytes: 1024 });
    const res = await handler(ctx(`http://x/api/img?url=${encodeURIComponent('https://cdn.example.com/big.png')}`));
    expect(res.status).toBe(413);
  });

  it('关闭反代时 302 回原始地址（行为与改动前一致）', async () => {
    const cacheDir = await tmpDir();
    const handler = handlerWith(cacheDir, (async () => { throw new Error('不该发起请求'); }) as unknown as typeof fetch, {
      enabled: false
    });
    const url = 'https://cdn.example.com/a.png';
    const res = await handler(ctx(`http://x/api/img?url=${encodeURIComponent(url)}`));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(url);
  });

  it('直通域名（本站 / 对象存储公网域名）302 回原始地址', async () => {
    const cacheDir = await tmpDir();
    const handler = handlerWith(cacheDir, (async () => { throw new Error('不该发起请求'); }) as unknown as typeof fetch, {
      passthroughHosts: ['cdn.example.com']
    });
    const res = await handler(ctx(`http://x/api/img?url=${encodeURIComponent('https://cdn.example.com/a.png')}`));
    expect(res.status).toBe(302);
  });

  it('重定向逐跳校验：跳进内网即拒绝，不交给 fetch 自动跟随', async () => {
    const cacheDir = await tmpDir();
    const impl = (async () =>
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret.png' } })) as unknown as typeof fetch;
    const handler = handlerWith(cacheDir, impl);
    const res = await handler(ctx(`http://x/api/img?url=${encodeURIComponent('https://cdn.example.com/r.png')}`));
    expect(res.status).toBe(403);
  });

  it('抓取失败后短期记忆，60s 内不再重复超时（302 交回浏览器直连）', async () => {
    const cacheDir = await tmpDir();
    let calls = 0;
    const impl = (async () => {
      calls++;
      return imageResponse(new Uint8Array(Buffer.from('nope')), 'text/plain', 500);
    }) as unknown as typeof fetch;
    const handler = handlerWith(cacheDir, impl);
    const q = `http://x/api/img?url=${encodeURIComponent('https://cdn.example.com/dead.png')}`;
    const first = await handler(ctx(q));
    expect(first.status).toBe(502);
    const second = await handler(ctx(q));
    expect(second.status).toBe(302);
    expect(calls).toBe(1);
  });
});

describe('写路径预热', () => {
  it('从写接口响应里挑出封面与正文前几张外链图', () => {
    const body = {
      ok: true,
      post: {
        id: 'p1',
        cover: 'https://cdn.example.com/cover.webp',
        content:
          '![a](https://cdn.example.com/1.png) 文字 ![相对](/media/2.png) ' +
          '<img src="https://cdn.example.com/3.png"> <img src="/media/4.png">'
      }
    };
    const urls = collectWarmableImages(body);
    expect(urls).toContain('https://cdn.example.com/cover.webp');
    expect(urls).toContain('https://cdn.example.com/1.png');
    expect(urls).toContain('https://cdn.example.com/3.png');
    // 相对地址是本站资源，不该被送去预热
    expect(urls.some((u) => u.startsWith('/'))).toBe(false);
  });

  it('响应体不是预期结构时返回空数组，不抛异常', () => {
    expect(collectWarmableImages(null)).toEqual([]);
    expect(collectWarmableImages({ ok: true })).toEqual([]);
    expect(collectWarmableImages({ post: null })).toEqual([]);
  });

  it('POST /api/posts 的处理器：写成功后预热封面，且原响应原样返回', async () => {
    const route = postRoutes.find((r) => r.method === 'POST' && r.path === '/api/posts');
    expect(route, '未找到 POST /api/posts 路由').toBeTruthy();

    const seen: string[][] = [];
    setImageWarmer((urls) => seen.push(urls));
    const payload = JSON.stringify({
      ok: true,
      post: { id: 'p1', cover: 'https://cdn.example.com/warm.webp', content: '![x](https://cdn.example.com/in.png)' }
    });
    const callUpstream = async () =>
      new Response(payload, { status: 201, headers: { 'content-type': 'application/json' } });

    try {
      const res = await route!.handler({ callUpstream } as unknown as ApiContext);
      expect(res.status).toBe(201);
      // 关键：预热读的是 clone，原响应必须还能被消费者完整读出
      expect(await res.text()).toBe(payload);
      await new Promise((r) => setTimeout(r, 30));
      const warmed = seen.flat();
      expect(warmed).toContain('https://cdn.example.com/warm.webp');
      expect(warmed).toContain('https://cdn.example.com/in.png');
    } finally {
      setImageWarmer(null);
    }
  });

  it('写失败（非 2xx）不触发预热', async () => {
    const route = postRoutes.find((r) => r.method === 'POST' && r.path === '/api/posts');
    const seen: string[][] = [];
    setImageWarmer((urls) => seen.push(urls));
    const callUpstream = async () => new Response(JSON.stringify({ error: '缺少 title' }), { status: 400 });
    try {
      const res = await route!.handler({ callUpstream } as unknown as ApiContext);
      expect(res.status).toBe(400);
      await new Promise((r) => setTimeout(r, 30));
      expect(seen).toHaveLength(0);
    } finally {
      setImageWarmer(null);
    }
  });

  it('warmImageCache 未注册预热器时是空操作；注册后去重并转发', () => {
    // 未注册：不能抛
    expect(() => warmImageCache(['https://a.example.com/x.png'])).not.toThrow();

    const seen: string[][] = [];
    setImageWarmer((urls) => seen.push(urls));
    try {
      warmImageCache(['https://a.example.com/x.png', 'https://a.example.com/x.png', '/media/local.png']);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual(['https://a.example.com/x.png']);
    } finally {
      setImageWarmer(null);
    }
  });
});

describe('SSR 与前端两套改写实现必须一致', () => {
  it('SSR 列表封面走反代地址', () => {
    resetImageProxy();
    const post = { id: 'p1', title: 'T', cover: 'https://cdn.example.com/a.png' } as unknown as PostRow;
    const html = renderHomeContent([post], {} as SiteIdentity);
    expect(html).toContain('/api/img?url=' + encodeURIComponent('https://cdn.example.com/a.png'));
    expect(html).not.toContain('src="https://cdn.example.com/a.png"');
  });

  it('app.js 注入的 proxiedImg() 与 imageProxyUrl() 判定规则一致', () => {
    const app = fs.readFileSync(path.resolve('app/public/app.js'), 'utf8');
    expect(app).toContain('function proxiedImg(');
    // 同源判定：两边都按 host 比较
    expect(app).toContain("new URL(s, location.href).host === location.host");
    // 只改写 http(s)
    expect(app).toContain('/^https?:\\/\\//i');
    // 输出格式与 TS 侧一致
    expect(app).toContain("'/api/img?url=' + encodeURIComponent(s)");
  });

  it('前端五个改写点都已接入（封面 / 正文 / 头像 / 前后台 favicon）', () => {
    const app = fs.readFileSync(path.resolve('app/public/app.js'), 'utf8');
    expect(app).toContain('proxiedImg(String((p && p.cover)');
    expect(app).toContain("'<img src=\"' + proxiedImg(src) + '\"");
    expect(app).toContain('esc(proxiedImg(profAvatar))');
    expect(app).toContain("_fl.setAttribute('href', proxiedImg(_fv))");
    expect(app).toContain("faviconLink.setAttribute('href', proxiedImg(siteAvatar))");
  });
});
