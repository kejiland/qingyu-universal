import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const pub = path.resolve('app/public');
const read = (name: string) => fs.readFileSync(path.join(pub, name), 'utf8');
const size = (name: string) => fs.statSync(path.join(pub, name)).size;

describe('公开站前端拆分（v0.7-b）', () => {
  it('index.html 通过轻量启动器加载，不再首屏直连整包 app.min.js', () => {
    const html = read('index.html');
    expect(html).toContain('boot.min.js?v=');
    expect(html).not.toContain('<script defer src="app.min.js');
  });

  it('启动器对 SSR 页面空闲加载，对无内容/后台路由立即加载', () => {
    const boot = read('boot.js');
    expect(boot).toContain('requestIdleCallback');
    expect(boot).toContain('.boot-load');
    expect(boot).toContain("'/write'");
    expect(boot).toContain("'/preview/'");
    expect(boot).toContain('/edit');
  });

  it('旧后台代码已从主包移出，只保留按需加载入口', () => {
    const app = read('app.js');
    const legacy = read('admin-legacy.js');
    expect(app).toContain('function ensureLegacyAdmin()');
    expect(app).toContain('admin-legacy.min.js');
    expect(app).not.toMatch(/function renderAdmin\s*\(/);
    expect(legacy).toMatch(/function renderAdmin\s*\(/);
    expect(legacy).toMatch(/function renderWrite\s*\(/);
  });

  it('压缩产物已生成：主包瘦身，回退包独立按需下载', () => {
    // 旧主包约 184 KB；拆出旧后台后应明显小于这个值。
    expect(size('app.min.js')).toBeLessThan(170 * 1024);
    expect(size('admin-legacy.min.js')).toBeGreaterThan(20 * 1024);
    expect(size('boot.min.js')).toBeLessThan(4 * 1024);
    expect(read('app.min.js')).toContain('admin-legacy.min.js');
    expect(read('admin-legacy.min.js')).toContain('function renderAdmin');
  });

  it('缓存清单包含新分包，版本号保持一致', () => {
    const app = read('app.js');
    const sw = read('sw.js');
    const version = app.match(/BLOG_VERSION\s*=\s*'([^']+)'/)?.[1];
    expect(version).toBeTruthy();
    expect(sw).toContain(`CACHE_VERSION = '${version}'`);
    expect(sw).toContain('./boot.min.js');
    expect(sw).toContain('./admin-legacy.min.js');
  });
});

describe('公开站视觉打磨（v0.8）', () => {
  it('index.html 在主样式之后加载独立叠加样式 polish.min.css', () => {
    const html = read('index.html');
    const main = html.indexOf('style.min.css?v=');
    const polish = html.indexOf('polish.min.css?v=');
    expect(main).toBeGreaterThan(-1);
    expect(polish).toBeGreaterThan(main);
    const app = read('app.js');
    const version = app.match(/BLOG_VERSION\s*=\s*'([^']+)'/)?.[1];
    expect(html).toContain('polish.min.css?v=' + version);
  });

  it('Service Worker 与缓存头都登记了 polish.min.css', () => {
    const sw = read('sw.js');
    const headers = read('_headers');
    expect(sw).toContain('./polish.min.css');
    expect(headers).toContain('/polish.min.css*');
    expect(headers).toMatch(/\/polish\.min\.css\*[\s\S]{0,120}immutable/);
  });

  it('叠加样式由构建脚本压缩产出', () => {
    expect(read('polish.css')).toContain('--accent');
    expect(read('polish.css')).toContain('prefers-reduced-motion');
    // 未压缩约 11 KB，压缩后必须显著变小
    expect(size('polish.min.css')).toBeLessThan(size('polish.css'));
    expect(read('polish.min.css')).toContain('--accent');
  });

  it('日期展示统一走 fmtDate，收敛成 YYYY-MM-DD', () => {
    const app = read('app.js');
    expect(app).toContain('function fmtDate(');
    expect(app).toContain('esc(fmtDate(p.date) || ');
    expect(app).toContain('esc(fmtDate(post.date) || ');
    expect(app).toContain('esc(fmtDate(c.date) || ');
    // 机器可读字段不能被动过
    expect(app).toContain("'datePublished': p.date || ''");
    expect(app).toContain('function rfc822(dateStr)');
  });

  it('SSR 与前端共用同一套日期规整规则', () => {
    expect(read('../../src/ssr/format.ts')).toContain('export function formatDate');
    const list = read('../../src/ssr/list.ts');
    const post = read('../../src/ssr/post.ts');
    expect(list).toContain('formatDate(post.date)');
    expect(post).toContain('formatDate(post.date)');
  });


  it('Service Worker 对带 ?v= 的静态资源按完整 URL 精确命中', () => {
    const sw = read('sw.js');
    expect(sw).toContain("searchParams.has('v')");
    expect(sw).toMatch(/var cached = await caches\.match\(request\);/);
    // 精确命中失败、且带版本号时，不允许退回 ignoreSearch（会吃到旧字节）
    expect(sw).toMatch(/if \(!cached && !versioned\) cached = await caches\.match\(request, \{ ignoreSearch: true \}\);/);
  });

  it('卡片摘要在 content 为空时回退到 search 全文', () => {
    expect(read('app.js')).toContain("stripMd(p.content || p.search || '')");
  });
});

describe('后台操作日志（审计）', () => {
  /** 后台筛选下拉里登记的动作（app/public/admin.js 的 AUDIT_ACTIONS） */
  function uiActions(): string[] {
    const m = /var AUDIT_ACTIONS\s*=\s*\[([\s\S]*?)\]/.exec(read('admin.js'));
    if (!m) return [];
    return (m[1]!.match(/'[^']+'/g) || []).map((s) => s.slice(1, -1));
  }

  /** 后端真正会写入的 action：从 recordAudit/auditFromContext 调用点抓字符串字面量。
   *  启发式（够用）：只在调用点后 160 字符内找 `'a.b'` 形状的字面量，
   *  因此 `op === 'rename' ? 'tag.rename' : 'tag.delete'` 这种三元也能两个都抓到；
   *  而 `'breakGlass'` / `''` / SQL 语句这类不带点的字面量会被过滤掉。 */
  function backendActions(): string[] {
    const files = [
      'app/functions/_lib/api-core.js',
      'app/functions/_lib/backup.js',
      'src/api/routes/admin-ai.ts',
      'src/api/routes/admin-storage.ts'
    ];
    const out = new Set<string>();
    for (const rel of files) {
      const abs = path.resolve(rel);
      if (!fs.existsSync(abs)) continue;
      const text = fs.readFileSync(abs, 'utf8');
      const re = /(?:recordAudit|auditFromContext)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        for (const lit of text.slice(m.index, m.index + 160).match(/'[^']*'/g) || []) {
          const v = lit.slice(1, -1);
          if (/^[a-z]+(\.[a-z]+)+$/.test(v)) out.add(v);
        }
      }
    }
    return [...out].sort();
  }

  const LOCALES = ['zh-CN', 'en', 'ja', 'ko', 'hi'];

  it('后端每个审计动作都能在筛选下拉里选到', () => {
    const ui = new Set(uiActions());
    const missing = backendActions().filter((a) => !ui.has(a));
    // 曾经就栽在这里：tag.rename / tag.delete / comment.bulk 会被写入，
    // 但 AUDIT_ACTIONS 里没有 —— 只能靠「全部类型」偶然看到。
    expect(missing).toEqual([]);
  });

  it('筛选下拉里的动作都确实由后端写入（没有失效选项）', () => {
    const backend = new Set(backendActions());
    expect(uiActions().filter((a) => !backend.has(a))).toEqual([]);
  });

  it('每个审计动作在 5 种语言里都有文案', () => {
    for (const lang of LOCALES) {
      const dict = JSON.parse(
        fs.readFileSync(path.resolve(`app/public/locales/${lang}.json`), 'utf8')
      ) as Record<string, string>;
      const missing = uiActions().filter((a) => !dict[`admin.audit.a.${a}`]);
      expect({ lang, missing }).toEqual({ lang, missing: [] });
    }
  });

  it('内置回退文案（i18n.js）也覆盖了每个动作', () => {
    const fallback = read('i18n.js');
    const missing = uiActions().filter((a) => !fallback.includes(`"admin.audit.a.${a}"`));
    expect(missing).toEqual([]);
  });

  it('保留了日志保留策略（自动裁剪，避免表无限膨胀）', () => {
    const core = fs.readFileSync(path.resolve('app/functions/_lib/api-core.js'), 'utf8');
    expect(core).toContain('export async function trimAuditLog');
    expect(core).toContain('AUDIT_MAX_ROWS');
    expect(core).toContain('AUDIT_RETENTION_DAYS');
    // 写入路径节流裁剪 + 读取路径必裁剪，两条都必须在
    expect(core).toMatch(/auditWrites\s*%\s*AUDIT_TRIM_EVERY/);
    expect(core).toMatch(/request\.method === 'GET'[\s\S]{0,120}trimAuditLog\(env\)/);
  });
});

/* 回归：滚动侧边栏到底部再点导航项，侧边栏会自己弹回顶部。
 * 根因是 mount() 里 renderShell() 用 root.innerHTML 整体重建外壳（含 <aside id="abSider">），
 * 新建节点的 scrollTop 恒为 0 —— 导航本身没变，只是高亮项变了，滚动位置却被丢掉了。 */
describe('后台侧边栏切页保留滚动位置', () => {
  it('重建外壳前先记住 .ab-nav 的 scrollTop，重建后接回去', () => {
    const admin = read('admin.js');
    const capture = admin.indexOf("root.querySelector('#abSider .ab-nav')");
    const shell = admin.indexOf('renderShell(root, route, pendingCount)');
    // 必须在 renderShell 之前读旧节点的 scrollTop —— 晚一步旧 DOM 就没了
    expect(capture).toBeGreaterThan(0);
    expect(shell).toBeGreaterThan(capture);
    // 恢复必须紧跟在 renderShell 之后（新节点还没被替换掉之前）
    expect(admin).toMatch(/renderShell\(root, route, pendingCount\);[\s\S]{0,400}?nextNav\.scrollTop = navScrollTop;/);
  });

  it('缓存版本号三处一致（改了 admin.js 必须同时提升，否则浏览器仍拿旧产物）', () => {
    const appVer = /var BLOG_VERSION = '([^']+)'/.exec(read('app.js'))?.[1];
    const swVer = /var CACHE_VERSION = '([^']+)'/.exec(read('sw.js'))?.[1];
    expect(appVer).toBeTruthy();
    expect(swVer).toBe(appVer);
    // admin.min.js 由 app.js 以 admin.min.js?v=BLOG_VERSION 注入（app.js:1930），
    // 所以只要 BLOG_VERSION 提了，后台产物也会跟着换 URL；这里顺带确认 index.html 同步。
    const vs = new Set([...read('index.html').matchAll(/\?v=([0-9]+\.[0-9]+\.[0-9]+)/g)].map((m) => m[1]));
    expect([...vs]).toEqual([appVer]);
  });
});

/* 媒体「复制链接 / 复制 MD」必须给完整地址。
 * 存储值故意是根相对（/media/x.png），见 src/bindings/storage.ts 的
 * normalizeLocalObjectUrls() —— 绑死 host 后换域名/端口访问就全失效。
 * 所以在复制这一刻补全域名，而不是改存储值。 */
describe('媒体复制链接为完整地址', () => {
  it('存在 absUrl() 补全助手，且优先用站点对外地址（而非浏览器 origin）', () => {
    const admin = read('admin.js');
    expect(admin).toMatch(/function absUrl\s*\(/);
    // 与 1143/2224 行、前台 app.js 的既有写法一致：先 cfg().siteUrl，再退 location.origin
    expect(admin).toMatch(/function absUrl[\s\S]{0,1200}?cfg\(\)\s*&&\s*cfg\(\)\.siteUrl/);
    expect(admin).toMatch(/function absUrl[\s\S]{0,1200}?location\.origin/);
    // 已是绝对 URL / data: / 协议相对的一律原样放行，避免二次拼接
    expect(admin).toMatch(/function absUrl[\s\S]{0,1000}?a-z0-9\+\.\-\]\*:/);
  });

  it('siteUrl 还是 localhost 占位值时改用浏览器 origin（否则复制出打不开的链接）', () => {
    const admin = read('admin.js');
    // SITE_URL 未配时后端默认 http://localhost:<PORT>（src/config.ts），照搬就是废链接
    expect(admin).toMatch(/function isLoopbackUrl\s*\(/);
    for (const h of ["'localhost'", "'127.0.0.1'", "'::1'", "'0.0.0.0'"]) {
      expect(admin).toContain(h);
    }
    expect(admin).toMatch(/isLoopbackUrl\(site\)\s*\?\s*\(origin\s*\|\|\s*site\)\s*:\s*\(site\s*\|\|\s*origin\)/);
  });

  it('复制按钮与复制 MD 都经过 absUrl()', () => {
    const admin = read('admin.js');
    expect(admin).toMatch(/copyText\(absUrl\(dec\(b\.getAttribute\('data-copy'\)\)\)\)/);
    expect(admin).toMatch(/'\]\(' \+ absUrl\(dec\(b\.getAttribute\('data-mdimg'\)\)\) \+ '\)'/);
    // 反过来：不允许残留未补全的裸复制
    expect(admin).not.toMatch(/copyText\(dec\(b\.getAttribute\('data-copy'\)\)\)/);
  });

  it('写入文章内容的路径仍用根相对地址（不能反过来把 host 绑进正文）', () => {
    const admin = read('admin.js');
    // 媒体选择器把 url 填进 #abCover / 正文，这里必须是原值
    expect(admin).toMatch(/data-url="' \+ esc\(m\.url\) \+ '"/);
    expect(admin).not.toMatch(/data-url="' \+ esc\(absUrl\(m\.url\)\) \+ '"/);
  });
});

/* 后台「设置 → 存储」：媒体 / 音乐文件保存在哪、能不能换成第三方云端。
 * 这条链路有几个必须守住的边界，写死成断言比写在注释里可靠。 */
describe('后台存储配置页', () => {
  const admin = read('admin.js');
  /** 上面的 read() 只解析 app/public 下的文件名；src/ 下的后端文件走绝对路径 */
  const readSrc = (rel: string) => fs.readFileSync(path.resolve(rel), 'utf8');

  it('设置页存在「存储」tab，并渲染独立保存的配置页', () => {
    expect(admin).toMatch(/data-tab="storage"/);
    expect(admin).toMatch(/t\('admin\.settings\.storageTab'\)/);
    expect(admin).toMatch(/function bindStorageSettings\s*\(/);
  });

  it('配置页走独立接口，不混进统一的「保存设置」', () => {
    // 与 AI 页同理：/api/settings 是公开 GET + 带缓存头，Secret 绝不能进那里
    expect(admin).toContain("api('api/admin/storage'");
    expect(admin).toContain("'api/admin/storage'");
    expect(admin).toContain("'api/admin/storage/test'");
    expect(admin).toContain("'api/admin/storage/migrate'");
    // 密钥不能进 settingsDraft（否则会被 saveSettings 顺带序列化出去）
    expect(admin).not.toMatch(/settingsDraft\.storage\s*=/);
  });

  it('Secret 只在输入框单向提交：留空=不改，清空要显式勾选', () => {
    expect(admin).toMatch(/if \(s\) body\.secretAccessKey = s;/);
    expect(admin).toMatch(/if \(clearEl && clearEl\.checked\) body\.clearSecretAccessKey = true;/);
    // 输入密钥就自动取消「清除」，避免两个意图打架
    expect(admin).toMatch(/secretEl\.addEventListener\('input'[\s\S]{0,160}?clearEl\.checked = false;/);
  });

  it('连通性测试与保存共用同一个请求体映射（否则「测通了却存不进去」）', () => {
    expect(admin).toMatch(/function payload\(\)\s*\{/);
    const save = admin.indexOf('JSON.stringify(payload())');
    expect(save).toBeGreaterThan(0);
    const test = admin.indexOf('JSON.stringify(payload())', save + 1);
    expect(test).toBeGreaterThan(save);
  });

  it('只有选了对象存储才展开 S3 表单', () => {
    // syncMode() 按当前选中的 radio 切换 #abStS3Box 的显隐
    expect(admin).toMatch(/function syncMode\(\)\s*\{[\s\S]{0,200}?s3Box\.style\.display = mode\(\) === 's3'/);
    expect(admin).toMatch(/var s3Box = content\.querySelector\('#abStS3Box'\)/);
    expect(admin).toMatch(/input\[name="abStMode"\]'\)\.forEach\(function \(r\) \{ r\.addEventListener\('change', syncMode\)/);
  });

  it('退化提示：选了云但配置不完整时明确告知仍用本机磁盘', () => {
    expect(admin).toMatch(/d\.degraded[\s\S]{0,160}?storageDegraded/);
    expect(admin).toMatch(/d\.mode === 's3'[\s\S]{0,160}?storageReady/);
  });

  it('迁移按钮把「本机文件数」重新拉一遍（迁移会改本地文件）', () => {
    expect(admin).toMatch(/async function migrate\(\)[\s\S]{0,1400}?await load\(\);/);
  });

  it('后端契约：四条路由 + 密钥打码 + 逐对象改写（不整库一把改）', () => {
    const route = readSrc('src/api/routes/admin-storage.ts');
    for (const p of ['/api/admin/storage', '/api/admin/storage/test', '/api/admin/storage/migrate']) {
      expect(route).toContain(p);
    }
    // 读接口只给打码值
    expect(route).toContain('secretAccessKeyMasked');
    expect(route).not.toMatch(/secretAccessKey:\s*config\.secretAccessKey/);
    // 每个路由都必须过 adminGuard（本地实现不走上游，漏一个就是未授权写接口）
    expect((route.match(/await adminGuard\(ctx\)/g) || []).length).toBe(4);

    const migrate = readSrc('src/bindings/object-migrate.ts');
    // 只有确认已进桶的对象才改写引用，避免「库里指向云、云上没文件」
    expect(migrate).toMatch(/uploaded\.add\(object\.key\)/);
    expect(migrate).toMatch(/if \(!uploaded\.has\(key\)\) return null;/);
    // 默认不删本地副本
    expect(migrate).toMatch(/options\.deleteLocal && uploaded\.size/);
  });

  it('迁到云端后本地读取路由仍常驻（老文件不 404）', () => {
    const app = readSrc('src/app.ts');
    // 常驻 = 不受 storageMode 判断包裹
    expect(app).toMatch(/本地磁盘对象（常驻挂载）/);
    expect(app).not.toMatch(/config\.storageMode === 'local'[\s\S]{0,80}createPublicObjectHandler/);
    expect(app).toContain("for (const prefix of ['/media/*', '/music/*', '/og/*'])");
  });

  it('存储键不进公开设置接口', () => {
    const contract = readSrc('src/api/contract/storage.ts');
    const settings = readSrc('src/api/contract/posts.ts');
    expect(contract).toContain('secretAccessKeyMasked');
    // /api/settings 的响应 schema 里绝不能出现 secret
    expect(settings).not.toMatch(/secretAccessKey/i);
  });
});
