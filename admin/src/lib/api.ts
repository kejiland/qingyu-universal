/* ============================================================
 * API 客户端
 * ------------------------------------------------------------
 * 类型来自服务端契约生成的 generated/api.d.ts（通过 @api-types 别名）。
 * 已经进入契约的接口用生成类型；尚未进入的（认证、媒体）在下方用本地
 * 接口声明，并在契约补齐后替换——这样类型不会在补齐前变成 any。
 * ============================================================ */
import type { components, paths } from '@api-types';

export type PostSummary = components['schemas']['PostSummary'];
export type PostDetail = components['schemas']['PostDetail'];
export type Comment = components['schemas']['Comment'];
export type Seo = components['schemas']['Seo'];
export type PostListResponse = paths['/api/posts']['get']['responses'][200]['content']['application/json'];

/* ---------- 尚未进入契约的接口（下一步补进 src/api/contract） ---------- */

export interface LoginResponse {
  ok: true;
  token: string;
  expiresIn: number;
  mustChange: boolean;
  defaultPassword?: string;
}

export interface SessionInfo {
  authed: boolean;
  mustChange: boolean;
}

export interface MediaItem {
  id: string;
  name: string;
  url: string;
  thumb_url?: string;
  type: string;
  size: number;
  created_at: string;
}

export interface MediaUploadTicket {
  ok: true;
  uploadUrl: string;
  publicUrl: string;
  thumbUploadUrl: string;
  thumbPublicUrl: string;
  key: string;
  thumbKey: string;
  contentType: string;
  expiresIn: number;
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
  registerMedia: (item: { id: string; name: string; url: string; type: string; size: number; thumb_url?: string }) =>
    request<{ ok: true; media: MediaItem }>('/api/media', { method: 'POST', ...json(item) }),
  deleteMedia: (id: string) => request<{ ok: true }>(`/api/media/${encodeURIComponent(id)}`, { method: 'DELETE' }),

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