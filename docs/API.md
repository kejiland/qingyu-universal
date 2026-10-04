# API 契约层

本文说明 `src/api/` 的设计：为什么这么做、怎么加新接口、以及它如何防止文档变成谎话。

---

## 一、要解决什么

上游的 API 是 62 个手写路由分支（`worker.js` 里 40 个 `url.pathname ===`
加 22 个正则），加上 16 处 `await request.json()`，**零 schema 校验**。

后果：

- 客户端拿到 `{ error: '缺少 id 或 title' }` 这类临时拼的文案，字段路径不明确
- `title: {}` 这种类型错误会被 `String({})` 强转成 `"[object Object]"` 存进数据库
- 没有机器可读的接口描述，前端只能靠读代码或记忆手写 `fetch`
- 接口行为变更没有任何机制能发现

---

## 二、设计：三层同源

```
src/api/contract/*.ts     zod schema —— 唯一事实来源
        │
        ├──→ 运行时校验（拒绝坏请求，带字段路径的错误信息）
        ├──→ OpenAPI 3.1 文档（/openapi.json 与 generated/openapi.json）
        └──→ 客户端类型（generated/api.d.ts）
```

三者来自同一份 schema，不存在「文档写了但代码没做」的可能。

### 关键决定一：校验是只读的

契约层**不修改**转发给上游的请求：

```
请求 ──┬──→ 原样转发给上游 worker ──→ 响应原样返回（保留 CORS / 缓存头 / 状态码）
       └──→ clone() 后解析，仅用于判断是否 400
```

原因：zod 的 `z.object()` 默认会**剥掉未声明的字段**。如果拿解析后的结果去转发，
上游需要的字段会被静默删掉——这是引入校验时最容易踩的坑。克隆后解析、原样转发，
从根本上排除了这类行为变化。

同理，上游的 `normalizePost()` 对几乎所有字段都做 `String()` / `Number()` 强转，
并且显式支持 `tags` 传「数组或逗号分隔字符串」。因此请求 schema 故意保守：
只拒绝**明显会写入脏数据**的类型错误（如 `title: {}`），其余一律放行。

### 关键决定二：响应也要校验

如果只校验请求，schema 就只是「我以为的接口」。所以每条路由都声明响应 schema，
处理完再回头校验真实响应体：

| 模式 | 行为 | 用途 |
| --- | --- | --- |
| `off` | 不校验 | 生产默认（避免额外开销） |
| `warn` | 不一致时打日志，仍返回原响应 | 开发环境默认 |
| `strict` | 不一致时返回 500 并把差异写进响应体 | 测试 |

用环境变量 `API_VALIDATE_RESPONSES` 控制。

**这个机制立刻抓到了真实缺陷**：`POST /api/posts/:id/comments` 的响应里
**没有 `post_id`**——上游把它作为独立参数写库，返回的 `comment` 对象却不含该字段，
而列表接口 `GET /api/posts/:id/comments` 用 `SELECT *` 是有的。
两个接口的评论形状不同，靠读代码很难注意到。已拆成 `CommentCreatedSchema`
与 `CommentSchema` 两个 schema 表达这个差异。

---

## 三、加一个新接口

以「归档列表」为例，三步：

### 1. 在 `src/api/contract/` 里写 schema

```ts
export const ArchiveItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  date: z.string()
}).meta({ id: 'ArchiveItem' });          // 有 id 才会进 components.schemas

export const ArchiveResponseSchema = z.object({
  ok: z.literal(true),
  items: z.array(ArchiveItemSchema)
}).meta({ id: 'ArchiveResponse' });
```

> `.meta({ id })` 让 zod 输出 `$defs` + `$ref`，生成器再提升为
> `components.schemas`。没有它就只能是匿名内联结构，客户端类型会很难用。

### 2. 在 `src/api/routes/` 里登记路由

```ts
{
  method: 'GET',
  path: '/api/archive',
  tags: ['文章'],
  auth: 'public',
  summary: '归档列表',
  responses: {
    200: { description: '按年月分组的归档', schema: ArchiveResponseSchema }
  },
  handler: proxyToUpstream          // 99% 的情况：原样交给上游
}
```

`handler` 默认就是 `proxyToUpstream`——契约层只做校验，业务仍在上游。

### 3. 加契约测试

在 `tests/api-contract.test.ts` 里补一条，用真实请求验证响应。

### 4. 重新生成产物

```bash
npm run api:generate      # build + openapi:emit + api:types
```

CI 会检查 `generated/` 是否与契约一致，忘记提交会失败。

---

## 四、路由与兜底的关系

```
注册顺序（Hono 按注册顺序匹配）：
  1. /healthz                      自托管实现
  2. /api/posts … /api/settings    契约路由（校验 → 转发上游）
  3. /openapi.json                 文档
  4. /api/local-upload、/media/*   自托管实现
  5. / 与 /posts/:id               服务端 SEO
  6. /config.js                    配置注入
  7. *                             兜底 → 上游 worker.fetch()
```

**未迁移的接口不受任何影响**，仍然走第 7 条兜底，行为与 Cloudflare 版完全一致。
迁移一个域就是把它的路由从第 7 条提到第 2 条，可以逐个进行、随时停手。

两条路径共用同一份 `withEdgeHeaders()`（`src/edge.ts`），
所以 `CF-Connecting-IP` 注入、限流标识、来源统计的行为一致。

---

## 五、当前覆盖范围

| 域 | 已迁移 | 说明 |
| --- | --- | --- |
| 文章 | ✅ 5 个接口 | 列表 / 新建 / 详情 / 更新 / 删除 |
| 评论 | ✅ 2 个接口 | 列表 / 发表 |
| 检索 | ✅ 1 个 | 全文检索 |
| 设置 | ✅ 1 个 | 站点设置读取 |
| 系统 | ✅ `/healthz` | |
| 管理认证 | ⬜ | login / logout / setup / password |
| 媒体 / 音乐 | ⬜ | upload-url / 列表 / 删除 |
| 订阅 / Webmention / 统计 | ⬜ | |
| 备份 / 审计 / 错误日志 | ⬜ | |

剩余约 50 个操作，模式完全一致，属于机械工作。

---

## 六、产物说明

| 文件 | 用途 | 是否提交 |
| --- | --- | --- |
| `generated/openapi.json` | OpenAPI 3.1 规范，供任意工具消费 | ✅ 提交，CI 校验一致性 |
| `generated/api.d.ts` | TypeScript 类型，供前端 / 脚本使用 | ✅ 提交，CI 校验一致性 |
| `src/api/contract/*.ts` | 契约的**唯一**事实来源 | ✅ |

前端消费方式（未来拆分后台 SPA / 公开站时）：

```ts
import type { components, paths } from './generated/api.js';

type PostSummary = components['schemas']['PostSummary'];
type PostList = paths['/api/posts']['get']['responses'][200]['content']['application/json'];
```

或配合 `openapi-fetch` 直接得到类型安全的调用：

```ts
import createClient from 'openapi-fetch';
import type { paths } from './generated/api.js';

const client = createClient<paths>({ baseUrl: 'https://blog.example.com' });
const { data, error } = await client.GET('/api/posts');
//      ^? PostListResponse
```

---

## 七、命令

```bash
npm run openapi:emit      # 只生成 generated/openapi.json
npm run api:types         # 只生成 generated/api.d.ts
npm run api:generate      # 全量：build + emit + types
npm run typecheck:tests   # 测试代码（含生成类型）的编译期检查
npm test                  # 单元测试 + 契约测试
```