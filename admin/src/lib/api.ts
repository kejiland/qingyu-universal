/* ============================================================
 * API 客户端
 * ------------------------------------------------------------
 * 类型来自服务端契约生成的 generated/api.d.ts（通过 @api-types 别名）。
 * 已经进入契约的接口用生成类型；尚未进入的（认证、媒体）在下方用本地
 * 接口声明，并在契约补齐后替换——这样类型不会在补齐前变成 any。
 * ============================================================ */
import type { components, paths } from '@api-types';

export type { components, paths };

export type PostSummary = components['schemas']['PostSummary'];
export type PostDetail = components['schemas']['PostDetail'];
export type Comment = components['schemas']['Comment'];
export type Seo = components['schemas']['Seo'];
export type PostListResponse = paths['/api/posts']['get']['responses'][200]['content']['application/json'];

/* ---------- 全部来自服务端契约生成的类型 ---------- */

export type LoginResponse = components['schemas']['LoginResponse'];
export type MediaItem = components['schemas']['MediaItem'];
export type MediaCreated = components['schemas']['MediaCreated'];
export type MediaUploadTicket = components['schemas']['MediaUploadTicket'];
export type CommentAdminItem = components['schemas']['CommentAdminItem'];
export type AuditLogItem = components['schemas']['AuditLogItem'];
export type ErrorLogItem = components['schemas']['ErrorLogItem'];
export type BackupItem = components['schemas']['BackupItem'];

/* ---------- 尚未进入契约的本地类型（补齐契约后替换） ---------- */

/** GET /api/music 返回的曲目（兼容接口，schema 尚未登记）。 */
export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  url: string;
  cover: string;
  size: number;
  duration: number;
  sort: number;
  date: string;
}

/** 音乐上传签名（兼容接口，schema 尚未登记）。 */
export interface MusicUploadTicket {
  ok: true;
  uploadUrl: string;
  publicUrl: string;
  key: string;
  contentType: string;
  expiresIn: number;
}

/** 文章分析（兼容接口，schema 尚未登记）。range=all|30|7 */
export interface PostAnalyticsItem {
  id: string;
  title: string;
  date: string;
  excerpt: string;
  status: string;
  tags: string[];
  series: string;
  seriesOrder: number;
  views: number;
  likes: number;
  comments: number;
  score: number;
  trend: Array<{ date: string; views: number; likes: number; comments: number }>;
}

export interface PostAnalyticsResponse {
  ok: true;
  range: string;
  trendDays: number;
  summary: { views: number; likes: number; comments: number; posts: number };
  items: PostAnalyticsItem[];
}

/** 健康检查单项（兼容接口，schema 尚未登记）。 */
export interface HealthItem {
  key: string;
  ok: boolean;
  bound?: boolean;
  counts?: Record<string, number | null>;
}

export interface HealthResponse {
  ok: true;
  items: HealthItem[];
  checkedAt: number;
}


/** 文章修订历史条目（列表不含正文；兼容接口，schema 尚未登记）。 */
export interface PostRevisionMeta {
  id: number;
  postId: string;
  title: string;
  date: string;
  excerpt: string;
  cover: string;
  ogImage: string;
  pinned: boolean;
  protected: boolean;
  tags: string[];
  category: string;
  series: string;
  seriesOrder: number;
  status: string;
  publishAt: number | null;
  reason: string;
  createdAt: number;
}

/** 修订详情：在列表字段的基础上多出正文与加密标记。 */
export interface PostRevisionDetail extends PostRevisionMeta {
  content: string;
  enc: unknown;
}

/** AI 写作助手返回结果。 */
export interface AiAssistResponse {
  ok: true;
  result: string;
}

/** 预览链接（签名 token，默认 7 天有效）。 */
export interface PreviewLinkResponse {
  ok: true;
  token: string;
  url: string;
  expiresAt: number;
  ttlDays: number;
}

/* ---------- 错误与请求 ---------- */

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const TOKEN_KEY = 'qingyu.admin.token';

export const session = {
  get token(): string {
    try {
      return localStorage.getItem(TOKEN_KEY) ?? '';
    } catch {
      return '';
    }
  },
  set(token: string): void {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* 隐私模式下忽略 */
    }
  },
  clear(): void {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  }
};

/** 401 时触发一次，让路由层跳回登录页。 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

async function request<T>(path: string, init: RequestInit = {}, options: { auth?: boolean } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const token = session.token;
  if (options.auth !== false && token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message =
      data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `请求失败（HTTP ${response.status}）`;
    if (response.status === 401) {
      session.clear();
      onUnauthorized?.();
    }
    throw new ApiError(message, response.status);
  }
  return data as T;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

/* ---------- 接口 ---------- */

export const api = {
  /* 认证 */
  login: (password: string) => request<LoginResponse>('/api/admin/login', { method: 'POST', ...json({ password }) }, { auth: false }),
  logout: () => request<{ ok: true }>('/api/admin/logout', { method: 'POST' }),
  setup: (password: string, setupKey: string) =>
    request<{ ok: true; message: string }>(
      '/api/admin/setup',
      { method: 'POST', headers: setupKey ? { 'X-Setup-Key': setupKey } : {}, ...json({ password }) },
      { auth: false }
    ),

  /* 文章 */
  listPosts: (query: { full?: boolean; all?: boolean; page?: number; per?: number; status?: string; q?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.full) params.set('full', '1');
    if (query.all) params.set('all', '1');
    if (query.page) params.set('page', String(query.page));
    if (query.per) params.set('per', String(query.per));
    if (query.status && query.status !== 'all') params.set('status', query.status);
    if (query.q) params.set('q', query.q);
    const suffix = params.toString();
    return request<PostListResponse>(`/api/posts${suffix ? `?${suffix}` : ''}`);
  },
  getPost: (id: string) =>
    request<{ ok: true; post: PostDetail }>(`/api/posts/${encodeURIComponent(id)}`),
  createPost: (post: Partial<PostDetail> & { id: string; title: string }) =>
    request<{ ok: true; post: PostDetail }>('/api/posts', { method: 'POST', ...json(post) }),
  updatePost: (id: string, post: Partial<PostDetail>) =>
    request<{ ok: true; post: PostDetail }>(`/api/posts/${encodeURIComponent(id)}`, { method: 'PUT', ...json(post) }),
  deletePost: (id: string) =>
    request<{ ok: true }>(`/api/posts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /* 媒体 */
  listMedia: () => request<{ ok: true; media: MediaItem[] }>('/api/media'),
  uploadTicket: (filename: string, size: number, makeThumb = true) =>
    request<MediaUploadTicket>('/api/media/upload-url', { method: 'POST', ...json({ filename, size, makeThumb }) }),
  registerMedia: (item: { url: string; name?: string; type?: string; size?: number; thumbUrl?: string }) =>
    request<{ ok: true; media: MediaCreated }>('/api/media', { method: 'POST', ...json(item) }),
  deleteMedia: (id: string) => request<{ ok: true }>(`/api/media/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /* 音乐 */
  listMusic: () => request<{ ok: true; music: MusicTrack[] }>('/api/music'),
  musicUploadTicket: (filename: string, size: number) =>
    request<MusicUploadTicket>('/api/music/upload-url', { method: 'POST', ...json({ filename, size }) }),
  registerMusic: (track: {
    title: string;
    artist?: string;
    url: string;
    size?: number;
    duration?: number;
    cover?: string;
  }) => request<{ ok: true; track: MusicTrack }>('/api/music', { method: 'POST', ...json(track) }),
  updateMusic: (id: string, patch: { title: string; artist?: string; cover?: string; sort?: number; duration?: number }) =>
    request<{ ok: true }>(`/api/music/${encodeURIComponent(id)}`, { method: 'PUT', ...json(patch) }),
  deleteMusic: (id: string) => request<{ ok: true }>(`/api/music/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /* 评论管理 */
  listComments: (status: 'all' | 'pending' | 'approved' = 'all') =>
    request<{ ok: true; comments: CommentAdminItem[] }>(`/api/comments?status=${status}`),
  updateComment: (id: string, patch: { status?: 'approved' | 'pending'; pinned?: boolean; featured?: boolean; content?: string }) =>
    request<{ ok: true }>(`/api/comments/${encodeURIComponent(id)}`, { method: 'PUT', ...json(patch) }),
  deleteComment: (id: string) =>
    request<{ ok: true }>(`/api/comments/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  bulkComments: (op: 'approve' | 'pending' | 'delete', ids: string[]) =>
    request<{ ok: true; updated: number; op: string }>('/api/admin/comments/bulk', { method: 'POST', ...json({ op, ids }) }),

  /* 标签批量维护 */
  changeTag: (from: string, to: string | null) =>
    request<{ ok: true; updated: number }>(
      '/api/admin/tags',
      { method: 'POST', ...json({ op: to ? 'rename' : 'delete', from, to: to ?? '' }) }
    ),

  /* 日志 */
  listAudit: (limit = 200) => request<{ ok: true; logs: AuditLogItem[]; counts: Record<string, number> }>(`/api/admin/audit?limit=${limit}`),
  listErrors: () => request<{ ok: true; total: number; sumHits: number; errors: ErrorLogItem[] }>('/api/admin/errors'),

  /* 备份 */
  listBackups: () => request<{ ok: true; configured: boolean; backups: BackupItem[] }>('/api/admin/backups'),
  createBackup: () => request<{ ok: true; backup: BackupItem }>('/api/admin/backups', { method: 'POST' }),
  deleteBackup: (id: string) => request<{ ok: true }>(`/api/admin/backups/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  restoreBackup: (id: string) =>
    request<{ ok: true; result: Record<string, unknown> }>(`/api/admin/backups/${encodeURIComponent(id)}/restore`, { method: 'POST' }),

  /* 认证补充 */
  changePassword: (current: string, password: string) =>
    request<{ ok: true; message: string }>('/api/admin/password', { method: 'POST', ...json({ current, password }) }),

  /* 订阅者 */
  listSubscribers: () => request<components['schemas']['SubscriberListResponse']>('/api/admin/subscribers'),
  deleteSubscriber: (id: string) => request<{ ok: true }>(`/api/admin/subscribers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  updateSubscriber: (id: string, payload: { groups: string[] }) =>
    request<components['schemas']['SubscriberUpdateResponse']>(
      '/api/admin/subscribers/' + encodeURIComponent(id),
      { method: 'PUT', ...json(payload) }
    ),
  broadcast: (payload: Record<string, unknown>) =>
    request<components['schemas']['SubscriberBroadcastResponse']>('/api/admin/subscribers/broadcast', { method: 'POST', ...json(payload) }),

  /* 分享图（OG）：签发直传地址，前端 Canvas 出图后 PUT */
  ogUploadUrl: (postId: string) =>
    request<components['schemas']['OgUploadResponse']>('/api/admin/og-upload-url', { method: 'POST', ...json({ postId }) }),

  /* 关联阅读 / 单篇统计 */
  postRelations: (id: string) =>
    request<components['schemas']['PostRelationsResponse']>('/api/posts/' + encodeURIComponent(id) + '/relations'),
  postStats: (id: string) =>
    request<components['schemas']['PostStatsResponse']>('/api/posts/' + encodeURIComponent(id) + '/stats'),

  /* Webmention */
  listWebmentions: () => request<components['schemas']['WebmentionListResponse']>('/api/admin/webmentions'),
  deleteWebmention: (id: number) => request<{ ok: true }>(`/api/admin/webmentions/${id}`, { method: 'DELETE' }),

  /* AI 写作助手（服务端未配置 AI 时接口返回 404，前端据此整块隐藏） */
  aiPing: () => request<{ ok: true }>('/api/ai/ping'),
  aiAssist: (action: 'title' | 'tags' | 'polish' | 'translate', text: string, lang: string) =>
    request<AiAssistResponse>('/api/ai/assist', { method: 'POST', ...json({ action, text, lang }) }),

  /* 修订历史 */
  listRevisions: (id: string) =>
    request<{ ok: true; revisions: PostRevisionMeta[] }>('/api/posts/' + encodeURIComponent(id) + '/revisions'),
  getRevision: (id: string, rid: string | number) =>
    request<{ ok: true; revision: PostRevisionDetail }>(
      '/api/posts/' + encodeURIComponent(id) + '/revisions/' + encodeURIComponent(String(rid))
    ),
  restoreRevision: (id: string, rid: string | number) =>
    request<{ ok: true; post: PostDetail }>(
      '/api/posts/' + encodeURIComponent(id) + '/revisions/' + encodeURIComponent(String(rid)) + '/restore',
      { method: 'POST' }
    ),

  /* 预览链接 */
  previewLink: (postId: string, ttlDays = 7) =>
    request<PreviewLinkResponse>('/api/admin/preview-link', { method: 'POST', ...json({ postId, ttlDays }) }),

  /* 统计 */
  adminHealth: () => request<HealthResponse>('/api/admin/health'),
  statsTrend: () => request<components['schemas']['StatsTrendResponse']>('/api/stats/trend'),
  statsSources: () => request<components['schemas']['StatsSourcesResponse']>('/api/admin/stats/sources'),
  postAnalytics: (range: 'all' | '30' | '7' = 'all') =>
    request<PostAnalyticsResponse>(`/api/admin/post-analytics?range=${range}`),

  /* 设置 */
  getSettings: () => request<{ ok: true; settings: Record<string, string> }>('/api/settings'),
  saveSettings: (settings: Record<string, unknown>) =>
    request<{ ok: true; saved: number }>('/api/settings', { method: 'POST', ...json(settings) })
};

/** 直传到对象存储/本地端点，带进度回调。 */
export function uploadTo(url: string, file: Blob, contentType: string, onProgress?: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new ApiError(`上传失败（HTTP ${xhr.status}）`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('上传失败：网络错误', 0));
    xhr.send(file);
  });
}
