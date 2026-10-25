export type DomainJobKind = 'verify' | 'enable' | 'disable' | 'update' | 'remove';
export type DomainJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface DomainDnsRecord {
  domain: string;
  addresses: string[];
  matches: boolean;
}

export interface DomainJob {
  id: string;
  kind: DomainJobKind;
  status: DomainJobStatus;
  message: string;
  progress: number;
  createdAt: number;
  updatedAt: number;
  /** verify 任务完成后的 DNS 明细；其他任务可省略。 */
  publicIp?: string;
  dns?: DomainDnsRecord[];
}

export interface DomainStatus {
  ok: true;
  available: boolean;
  agentOnline: boolean;
  /** domain profile 当前是否启用（已保存域名但手动关闭 HTTPS 时为 false）。 */
  enabled: boolean;
  primary: string;
  aliases: string[];
  publicIp: string;
  httpsReady: boolean;
  dns: DomainDnsRecord[];
  activeJob: DomainJob | null;
  message: string;
}

export interface DomainActionRequest {
  primary: string;
  aliases?: string[];
  kind?: 'enable' | 'update';
}

export interface DomainRemoveRequest {
  mode?: 'disable' | 'remove';
}
