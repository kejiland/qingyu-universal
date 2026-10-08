# SEO 与服务端渲染

本文说明自托管版如何为文章页生成搜索引擎与社交爬虫可读的 HTML，以及它与上游
前端逻辑的对应关系。

---

## 一、背景：问题在哪

上游的 SEO 是**纯客户端**的：`app/public/app.js` 里的 `updateSEO(path)` 在页面加载后
用 `document.querySelector` 改写 `<title>`、`<meta>`、canonical 和 JSON-LD。

```
浏览器请求 /posts/hello/
   ↓
worker 返回 index.html（写死的 <title>Qingyu'Blog · 轻量博客</title>）
   ↓
app.js 执行 → updateSEO() 改写 meta   ← 只有执行 JS 的客户端才看得到
```

`index.html` 里那套 `<meta>` 是静态的，`og:url` 甚至是相对路径 `/`。后果：

- **社交爬虫**（微信、Twitter/X、Facebook、Discord、Slack）基本不执行 JS
  → 无论分享哪篇文章，卡片都是站点名 + 默认描述
- **搜索引擎**虽然多数会执行 JS，但首轮抓取拿到的仍是错误的标题与描述，
  且 canonical 指向 `/`（等于把所有文章声明成首页的副本）

而 `posts` 表里早就存好了 `seo`（`{title, desc, canonical, noindex}`）与 `og_image`——
后台能填、数据库能存，只是**没有任何一行被渲染进 HTML**。是渲染层缺失，不是数据缺失。

---

## 二、做法：把规则搬到服务端

新增两个 Hono 路由，注册在 catch-all 之前（因此先于上游 worker 命中）：

| 路由 | 文件 |
| --- | --- |
| `GET /` | `src/routes/seo.ts` → `home` |
| `GET /posts/:id[/]` | `src/routes/seo.ts` → `article` |

元数据的构造与渲染在 `src/seo/meta.ts`：

```
src/seo/meta.ts
  stripMarkdown()        与前端 stripMd 逐条对应，保证描述文本一致
  readSiteIdentity()     读 site_settings（site / footer / profile）
  buildArticleMeta()     文章元数据 + BlogPosting JSON-LD
  buildHomeMeta()        站点元数据 + WebSite JSON-LD（支持 noindex 变体）
  renderHeadBlock()      渲染成一段 HTML
  injectHead()           删除写死的旧标签、替换 <title>、插入新块
```

`injectHead()` 的处理方式：

1. 删除 `index.html` 里写死的 `description` / `robots` / `author` /
   `og:*` / `twitter:*` / `canonical` / JSON-LD，以及配套注释
2. 替换 `<title>`
3. 在 `</head>` 前插入新块

保留 `charset`、`viewport`、`theme-color`、`apple-mobile-web-app-*`、RSS / webmention /
ARD 等无关标签。测试会断言 head 里 canonical 与 JSON-LD 各只有一份。

---

## 三、字段优先级（与前端 `updateSEO()` 一致）

| 字段 | 优先级 |
| --- | --- |
| 标题 | `seo.title` → `「文章标题 · 站点名」` |
| 描述 | `seo.desc` → `excerpt` → 正文去 Markdown 后前 200 字 → 站点简介 |
| 分享图 | `og_image` → `cover` →（空则不输出 `og:image`，卡片降级为 `summary`） |
| canonical | `seo.canonical` → `https://<SITE_URL>/posts/<encodeURIComponent(id)>/` |
| robots | `seo.noindex` 或受保护文章 → `noindex, nofollow`，否则 `index, follow, max-image-preview:large, max-snippet:-1` |
| 作者 | `settings.profile.name` → `footer.copyrightName` → 站点名 |
| 站点名 | `settings.site.name` → `footer.copyrightName` → 内置默认 |

**注意一个容易写错的规则**：`seo.title` 是**完整替换**，不会追加站点名；
只有在没有 `seo.title` 时才拼成「标题 · 站点名」。这与前端的
`pageTitle = seo.title || (post.title + ' · ' + n)` 完全一致。

JSON-LD 结构（文章页）：

```json
{
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  "headline": "...",
  "description": "...",
  "datePublished": "<date>",
  "dateModified": "<updated_at 或 date>",
  "author": { "@type": "Person", "name": "..." },
  "publisher": { "@type": "Organization", "name": "..." },
  "mainEntityOfPage": "https://.../posts/<id>/",
  "image": "...",
  "keywords": ["...", "..."]
}
```

`dateModified` 用 `updated_at`（比前端的 `p.date` 更准确）。这是唯一有意保留的差异，
两者都是合法日期，不影响解析。

---

## 四、安全

标题、摘要等字段来自用户输入（后台可编辑），必须当作不可信内容处理：

- **HTML 属性转义**：`escapeHtml()` 处理 `& < > " '`，
  标题里的 `"><script>alert(1)</script>` 无法逃逸出 `content="..."` 属性
- **JSON-LD 转义**：`escapeJsonForScript()` 把 `<` `>` `&` 转成 `\u003c` 等，
  同时处理 U+2028 / U+2029（JS 里是换行符）
- **草稿不泄露**：非 `published` 的文章**只注入站点级信息**，绝不使用文章标题或正文
- **受保护文章**：`robots` 强制 `noindex`，且不使用 `content` 生成描述
  （读取路径本身也已把 `content` 清空，这里再兜一层）
- **响应头**：复用上游 `api-core.js` 导出的 `securityHeaders()`，
  与静态资源路径的 CSP / nosniff / frame 防护完全一致，不做第二份定义

测试覆盖：`tests/seo.test.ts` 中有专门的 XSS 用例，断言恶意标题不会在输出里
产生新的 `<script>` 或 `<img onerror>`。

---

## 五、缓存

- 文章页返回 `Cache-Control: no-cache` + `ETag: W/"post-<id>-<updated_at>"`
- 条件请求命中即返回 `304`
- 文章被编辑后 `updated_at` 变化 → ETag 变化 → 客户端与中间缓存自动失效

没有用强缓存（`max-age`），因为自托管环境不一定有 Cloudflare 那样的主动清缓存能力，
`no-cache`（每次带 ETag 校验）在小流量博客上是更稳的默认。

---

## 六、已知边界

1. **首页标题不做 i18n**。`index.html` 的静态标题与前端 `updateSEO()` 都会拼上
   `t('site.subtitle')`（"轻量博客"），服务端拿不到 i18n 运行时，因此首页标题只用站点名。
   配置了「站点名称」之后这个差异就消失了。
2. **站点简介的默认值沿用 i18n**（含 Cloudflare 字样），保证服务端与前端回退一致。
   自托管站点应在后台「站点基础信息 → 站点简介」里填写自己的描述。
3. ~~**仅覆盖首页与文章页**~~。现已覆盖首页、文章页，以及归档 / 标签 / 分类 /
   关于 / 友链 / 热门六个列表与固定页（v0.9-ac 起，见上节）。
4. **客户端仍会再改一次 meta**（`updateSEO()` 执行时），值基本一致，
   唯一差别是 `og:image` 前端用原始相对路径而服务端已绝对化。爬虫不执行 JS，
   拿到的是服务端版本；Google 会把相对 URL 按页面地址解析，因此无实际影响。
5. **SSR 只复刻同步态**（见上节）。浏览量、点赞数、评论列表等异步填充字段在
   服务端输出里是空占位，这是有意为之，不是漏渲染。

---

## 七、SSR 复刻口径：同步态，不是最终态

服务端渲染的 HTML 必须**与 `app.js` 接管前的那一版同构**，而不是与「页面最终长什么样」同构。

原因：`app.js` 是两段式的——`renderPost()` 同步吐出骨架，随后若干异步请求
（浏览量、点赞数、评论列表、精选卡片、相关文章、高亮按钮）再把内容填进去。
如果 SSR 把最终态一并渲染，用户在真机上看到的就是「有 → 无 → 有」的三段式闪烁：
首帧有内容 → `app.js` 接管后用同步态覆盖掉 → 异步回来再填上。

**SSR 必须留空的异步填充位**（`src/ssr/post.ts`）：

| 选择器 | 由谁填充 |
| --- | --- |
| `#viewCount` / `#likeCount` / `#commentCount` | 异步请求后写入 |
| `ul#commentList` | `loadComments()` |
| `#featuredGrid` | `loadFeatured()` |
| `#postRelations` | `loadRelations()` |
| `.reading-tools` 里的高亮 / 稍后读 / 导入导出 5 个按钮 | `initHighlight()` 事后 append |

反过来，**同步态里有的东西一个都不能少**。本轮实测发现文章页 SSR 比 SPA 少 **140+ 节点**，
已通过重写 `src/ssr/post.ts` 补齐：

- `post-header`（`.meta-date` → 作者 → `N 分钟阅读` → `.meta-views` → 系列 pin → 置顶 pin）
- `reading-tools`（只渲染字号三件套）、`ai-post-slot`、`toc`、`print-foot`、`like-bar`
- `article-footer`（含分享菜单）、系列导航、上下篇、`relations-slot`、webmentions、评论区骨架、featured、广告位

另外两处容易抄错的地方：

- **目录编号**：复刻 `buildToc()` + `stampHeadingNumbers()`——标题不足 2 个时
  `app.js` 提前 return、编号不计算，但**仍然插入空的 `.toc-num`**。
- **受保护文章**：上游对加密文章照样渲染标题 / meta / 锁屏，
  SSR 早期「直接返回 `null`」反而是不同构（真机上不会整页空白）。
  现在渲染标题 + `.post-lock` + 隐藏的 `<article id="postArticle">`。

> 验证方式：同路由双快照差分（服务端 HTML vs 真机 Chrome 里 `app.js` 渲染出的
> `#app` 子树）。`/`、`/archive`、`/tags`、`/categories`、`/about`、`/links`、`/popular`
> 要求**差异区归零**；文章页残留的差异必须逐条核对是否属于上表的异步填充位。

---

## 八、如何验证

```bash
# 直接看爬虫视角（不带 JS）
curl -s http://localhost:8787/posts/<文章id>/ | grep -E 'og:|canonical|<title>'
```

或用现成的在线工具抓取线上地址：Twitter Card Validator、Facebook Sharing Debugger、
微信调试工具。部署后建议检查一次，确认卡片能显示文章标题与封面。

自动化验证在 `tests/seo.test.ts`（22 项）以及端到端脚本中，覆盖注入、边界、
XSS、草稿泄露、ETag 与回归。