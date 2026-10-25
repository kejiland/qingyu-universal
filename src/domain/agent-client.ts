import type { AppConfig } from '../config.js';
import type { DomainJob, DomainStatus } from './types.js';

export interface AgentResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

export class DomainAgentClient {
  constructor(private readonly config: AppConfig) {}

  get configured(): boolean {
    return Boolean(this.config.domainAgent.url && this.config.domainAgent.token);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<AgentResult<T>> {
    if (!this.configured) return { ok: false, status: 503, error: 'Domain agent is not configured' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(this.config.domainAgent.url + path, {
        ...init,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + this.config.domainAgent.token,
          ...(init.headers || {})
        }
      });
      const text = await response.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 300) }; }
      if (!response.ok) {
        const error = data && typeof data === 'object' && 'error' in data
          ? String((data as { error: unknown }).error)
          : 'Agent returned HTTP ' + response.status;
        return { ok: false, status: response.status, data: data as T, error };
      }
      return { ok: true, status: response.status, data: data as T };
    } catch (e) {
      const message = (e as Error)?.name === 'AbortError' ? 'Domain agent timed out' : 'Domain agent unavailable: ' + ((e as Error)?.message || e);
      return { ok: false, status: 503, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  status() { return this.request<DomainStatus>('/status'); }
  verify(body: unknown) { return this.request<{ ok: true; job: DomainJob }>('/verify', { method: 'POST', body: JSON.stringify(body) }); }
  update(body: unknown) { return this.request<{ ok: true; job: DomainJob }>('/update', { method: 'POST', body: JSON.stringify(body) }); }
  disable() { return this.request<{ ok: true; job: DomainJob }>('/disable', { method: 'POST', body: '{}' }); }
  remove() { return this.request<{ ok: true; job: DomainJob }>('/remove', { method: 'POST', body: '{}' }); }
  job(id: string) { return this.request<{ ok: true; job: DomainJob }>('/jobs/' + encodeURIComponent(id)); }
}
