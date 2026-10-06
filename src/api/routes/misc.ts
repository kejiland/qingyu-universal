/* ============================================================
 * 兼容接口路径覆盖
 * ------------------------------------------------------------
 * 这些路径来自上游 worker 的公开路由。它们暂时还没有像文章/评论/媒体
 * 那样细分响应 schema，因此统一使用 unknown 响应：**先保证路径、方法、
 * 鉴权语义进入 OpenAPI 与运行时注册表，后续再逐步收紧字段**。
 * ============================================================ */
import { z } from 'zod';
import { ErrorResponseSchema } from '../contract/common.js';
import { proxyToUpstream, type ApiRoute, type HttpMethod } from '../registry.js';

const AUTH_ERRORS = {
  401: { description: '未授权或凭证失效', schema: ErrorResponseSchema }
} as const;

function compat(
  method: HttpMethod,
  path: string,
  auth: 'public' | 'admin',
  summary: string,
  tags: string[] = ['兼容接口'],
  statuses: number[] = [200]
): ApiRoute {
  const responses: ApiRoute['responses'] = {};
  for (const status of statuses) {
    responses[status] = { description: '兼容响应（字段将在后续版本逐步收紧）', schema: z.unknown() };
  }
  if (auth === 'admin') Object.assign(responses, AUTH_ERRORS);
  return { method, path, auth, summary, tags, responses, handler: proxyToUpstream };
}

export const miscRoutes: ApiRoute[] = [
  compat('GET', '/api/popular', 'public', '热门文章', ['文章']),

  compat('POST', '/api/subscribe', 'public', '订阅邮件', ['订阅'], [200, 201]),
  compat('GET', '/api/subscribe/confirm', 'public', '确认订阅', ['订阅']),
  compat('GET', '/api/subscribe/unsubscribe', 'public', '取消订阅', ['订阅']),

  compat('POST', '/api/errors', 'public', '上报前端错误', ['日志'], [200, 201]),

  compat('POST', '/api/webmention', 'public', '接收 Webmention', ['Webmention'], [200, 201]),
  compat('GET', '/api/webmention', 'public', 'Webmention 列表', ['Webmention']),

  compat('GET', '/api/preview', 'public', '预览受保护文章', ['文章']),

  compat('POST', '/api/comments/:id/like', 'public', '评论点赞', ['评论']),
  compat('DELETE', '/api/posts/:id/comments/:cid', 'admin', '删除文章评论', ['评论']),

  compat('GET', '/api/posts/:id/revisions', 'admin', '文章修订列表', ['文章']),
  compat('GET', '/api/posts/:id/revisions/:rid', 'admin', '文章修订详情', ['文章']),
  compat('POST', '/api/posts/:id/revisions/:rid/restore', 'admin', '恢复文章修订', ['文章'], [200, 201]),

  compat('GET', '/api/site-files', 'public', '站点文件列表', ['站点']),
  compat('PUT', '/api/site-files', 'admin', '保存站点文件', ['站点']),
  compat('GET', '/api/site-files/:name', 'public', '读取站点文件', ['站点']),
  compat('PUT', '/api/site-files/:name', 'admin', '写入站点文件', ['站点']),
  compat('DELETE', '/api/site-files/:name', 'admin', '删除站点文件', ['站点']),

  compat('GET', '/api/feed.xml', 'public', 'RSS Feed', ['Feed']),
  compat('GET', '/api/sitemap.xml', 'public', 'Sitemap', ['SEO']),
  compat('GET', '/feed.xml', 'public', 'RSS Feed（兼容路径）', ['Feed']),
  compat('GET', '/sitemap.xml', 'public', 'Sitemap（兼容路径）', ['SEO']),

  compat('GET', '/api/ai/ping', 'public', 'AI 可用性检查', ['AI']),
  compat('POST', '/api/ai/ping', 'public', 'AI 可用性检查', ['AI']),
  compat('POST', '/api/ai/summary', 'public', 'AI 摘要', ['AI'], [200, 201]),
  compat('POST', '/api/ai/assist', 'admin', 'AI 写作助手', ['AI'], [200, 201]),
  compat('POST', '/api/ai/comments', 'public', 'AI 评论分析', ['AI'], [200, 201]),

  compat('POST', '/api/music/upload-url', 'admin', '音乐上传签名', ['音乐']),
  compat('GET', '/api/music', 'public', '音乐列表', ['音乐']),
  compat('POST', '/api/music', 'admin', '登记音乐', ['音乐'], [200, 201]),
  compat('PUT', '/api/music/:id', 'admin', '更新音乐', ['音乐']),
  compat('DELETE', '/api/music/:id', 'admin', '删除音乐', ['音乐']),

  compat('POST', '/api/admin/subscribers', 'admin', '新增订阅者', ['订阅'], [200, 201]),
  compat('GET', '/api/admin/post-analytics', 'admin', '文章分析', ['统计']),
  compat('POST', '/api/admin/preview-link', 'admin', '生成预览链接', ['文章'], [200, 201]),
  compat('GET', '/api/admin/health', 'admin', '后台健康检查', ['系统']),
  compat('GET', '/api/admin/tags', 'admin', '标签列表', ['文章'])
];
