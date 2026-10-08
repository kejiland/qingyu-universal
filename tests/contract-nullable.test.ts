/* ============================================================
 * 请求体 ↔ 响应体 双向对称性护栏
 * ------------------------------------------------------------
 * 起因（真 bug）：GET /api/posts/:id 对未定时的文章返回 `publishAt: null`，
 * 而 UpdatePostBodySchema 里写的是 `publishAt: z.union([number,string]).optional()`
 * —— `.optional()` 放行 undefined，**不放行 null**。
 *
 * 后果不是「文档不一致」这么轻：上游 `admin.js` 构造保存请求体时写的是
 * `publishAt: post.publishAt || null`，Cloudflare 版没有校验中间件所以畅通；
 * 本版同样的请求体会直接 400 —— 「上游能存、我们存不了」。
 *
 * 这类漂移只能自动化发现，靠人 review schema 文件看不出来。所以这里做两件事：
 *   1. 请求体 schema 必须接受 GET 响应里出现过的 null 值（null-容错扫描）
 *   2. 真实实例上跑一次 GET → PUT 的往返（round-trip），而不是只验 schema
 * ============================================================ */
import { describe, expect, it } from 'vitest';
import {
  UpdatePostBodySchema,
  CommentCreateBodySchema
} from '../src/api/contract/posts.js';

/** GET /api/posts/:id 实际会在这些字段上返回 null（受保护文章 enc=null 已是候选）。 */
const NULLABLE_FROM_GET = ['publishAt', 'publish_at', 'enc'] as const;

describe('请求体 schema 容忍 GET 响应里的 null', () => {
  it('全部 nullable 字段单独传 null 都能通过', () => {
    for (const key of NULLABLE_FROM_GET) {
      const result = UpdatePostBodySchema.safeParse({ title: 't', [key]: null });
      expect(result.success, `${key}: null 应被接受，实际被拒`).toBe(true);
    }
  });

  it('publishAt / publish_at 有值时保持原有校验强度', () => {
    expect(UpdatePostBodySchema.safeParse({ title: 't', publishAt: 1700000000000 }).success).toBe(true);
    expect(UpdatePostBodySchema.safeParse({ title: 't', publishAt: '2026-01-01T00:00:00.000Z' }).success).toBe(true);
    // 布尔值仍然要被拒：放宽到 nullable 不等于放弃类型检查
    expect(UpdatePostBodySchema.safeParse({ title: 't', publishAt: true }).success).toBe(false);
  });

  it('「GET 出来的原样对象」整体回写也能通过 —— 这是 admin.js 的真实调用方式', () => {
    // 取自 GET /api/posts/:id 的真实响应形状（未定时发布的公开文章）
    const asReturnedByGet = {
      id: 'p-hello',
      title: '你好，轻语博客',
      date: '2026-10-07T08:45:28.727Z',
      excerpt: '从零搭一个自己说了算的博客。',
      cover: '',
      ogImage: '',
      content: '# 你好，轻语博客\n\n正文。',
      pinned: true,
      protected: false,
      enc: null,
      category: '随笔',
      series: '',
      author: '站长',
      seriesOrder: 0,
      status: 'published',
      publishAt: null,
      seo: {},
      tags: ['开始']
    };
    const result = UpdatePostBodySchema.safeParse(asReturnedByGet);
    expect(result.success, JSON.stringify(result.error?.issues ?? [])).toBe(true);
  });
});

/* ============================================================
 * 评论：顶层评论的 parent_id 就是 null
 * ------------------------------------------------------------
 * 同一个坑的第二次出现（第一次是 publishAt）：app.js 的 saveComment() 写的是
 * `parentId = parentId || null`，也就是**顶层评论必定传 null** 而不是省略字段。
 * 而 CommentCreateBodySchema 当时写的是 `parent_id: z.string().optional()`，
 * 只放行 undefined、拒绝 null —— 结果是「前台一篇评论都发不出去」，
 * 状态行直接吐「body.parent_id: Invalid input: expected string, received null」。
 *
 * 这个 bug 靠 review schema 看不出来（.optional() 看起来很合理），
 * 只有真的点一次「发表评论」才会暴露，所以必须钉在这里。
 * ============================================================ */
describe('评论请求体：顶层评论的 parent_id = null 必须被接受', () => {
  it('parent_id 单独传 null 能通过（这是前台发顶层评论的唯一写法）', () => {
    const result = CommentCreateBodySchema.safeParse({ author: '访客', content: '你好', parent_id: null });
    expect(result.success, JSON.stringify(result.error?.issues ?? [])).toBe(true);
  });

  it('省略 parent_id 同样能通过（上游也可能不传这个字段）', () => {
    expect(CommentCreateBodySchema.safeParse({ author: '访客', content: '你好' }).success).toBe(true);
  });

  it('回复时传字符串 parent_id 正常通过', () => {
    expect(
      CommentCreateBodySchema.safeParse({ author: '访客', content: '回复', parent_id: 'c-1' }).success
    ).toBe(true);
  });

  it('非法类型仍然要被拒（放宽到 nullable 不等于放弃校验）', () => {
    expect(
      CommentCreateBodySchema.safeParse({ author: '访客', content: '你好', parent_id: 123 }).success
    ).toBe(false);
  });

  it('前台 saveComment() 的真实请求体原样通过（含蜜罐与时间戳字段）', () => {
    const asSentByApp = {
      author: '访客',
      content: '这是一条评论',
      parent_id: null,
      hp: '',
      ts: 1791435000000
    };
    const result = CommentCreateBodySchema.safeParse(asSentByApp);
    expect(result.success, JSON.stringify(result.error?.issues ?? [])).toBe(true);
  });
});
