/* ============================================================
 * 域名 Agent：唯一持有 Docker socket 的进程
 * ------------------------------------------------------------
 * 只暴露在 Compose 内网，不映射宿主端口。所有写操作串行执行，
 * .env 修改使用临时文件 + rename，并在 HTTPS 失败时恢复原字节。
 * ============================================================ */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import {
  DomainValidationError,
  canonicalDomain,
  domainEnvUpdates,
  mergeEnvText,
  normalizeDomains,
  verifyDns,
  type DnsResolver
} from '../domain/core.js';
import type { DomainJob, DomainStatus } from '../domain/types.js';

const exec = promisify(execFile);
const ROOT = path.resolve(process.env.QINGYU_PROJECT_DIR || '/project');
const ENV_FILE = path.resolve(process.env.QINGYU_ENV_FILE || path.join(ROOT, '.env'));
const STATE_DIR = path.resolve(process.env.DOMAIN_AGENT_STATE_DIR || '/state');
const TOKEN = String(process.env.DOMAIN_AGENT_TOKEN || '');
const PORT = Number(process.env.DOMAIN_AGENT_PORT || 8790);
const PUBLIC_IP = String(process.env.QINGYU_PUBLIC_IP || '').trim();
const APP_PORT = Number(process.env.APP_PORT || 8787);
const ENV_PROFILES = String(process.env.COMPOSE_PROFILES || '');

if (TOKEN.length < 24) {
  console.error('[domain-agent] DOMAIN_AGENT_TOKEN 必须至少 24 个字符');
  process.exit(1);
}
fs.mkdirSync(STATE_DIR, { recursive: true });

const jobsFile = path.join(STATE_DIR, 'jobs.json');
let jobs = loadJobs();
recoverInterruptedJobs();
let queue: Promise<void> = Promise.resolve();

function loadJobs(): DomainJob[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((job) => job && typeof job.id === 'string') as DomainJob[];
  } catch { return []; }
}

function recoverInterruptedJobs(): void {
  let changed = false;
  for (const job of jobs) {
    if (job.status !== 'queued' && job.status !== 'running') continue;
    job.status = 'failed';
    job.message = 'Agent 重启，未完成任务已中断；请重新执行。';
    job.progress = 100;
    job.updatedAt = Date.now();
    changed = true;
  }
  if (changed) saveJobs();
}

function saveJobs(): void {
  const tmp = jobsFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(jobs.slice(-50)), { mode: 0o600 });
  fs.renameSync(tmp, jobsFile);
}

function updateJob(job: DomainJob, patch: Partial<DomainJob>): void {
  Object.assign(job, patch, { updatedAt: Date.now() });
  saveJobs();
}

function publicJob(job: DomainJob): DomainJob {
  return { ...job };
}

function activeJob(): DomainJob | null {
  return jobs.find((job) => job.status === 'running' || job.status === 'queued') || null;
}

function createJob(kind: DomainJob['kind']): DomainJob {
  const now = Date.now();
  const job: DomainJob = {
    id: crypto.randomUUID(),
    kind,
    status: 'queued',
    message: '任务已排队',
    progress: 0,
    createdAt: now,
    updatedAt: now
  };
  jobs.push(job);
  saveJobs();
  return job;
}

function enqueue(job: DomainJob, work: () => Promise<{ message: string; status?: 'succeeded' | 'failed' }>): void {
  queue = queue.then(async () => {
    updateJob(job, { status: 'running', message: '开始执行', progress: 10 });
    try {
      const result = await work();
      updateJob(job, { status: result.status || 'succeeded', message: result.message, progress: 100 });
    } catch (e) {
      updateJob(job, { status: 'failed', message: (e as Error)?.message || String(e), progress: 100 });
    }
  });
}

function isSafeToken(value: string): boolean {
  const given = Buffer.from(String(value || ''), 'utf8');
  const expected = Buffer.from(TOKEN, 'utf8');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('请求体必须是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

const resolver: DnsResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return { addresses: records.map((r) => r.address) };
};

function configuredPublicIp(): string {
  const fromProcess = PUBLIC_IP && isIP(PUBLIC_IP) ? PUBLIC_IP : '';
  if (fromProcess) return fromProcess;
  const fromFile = envValue(readEnv(), 'QINGYU_PUBLIC_IP');
  return isIP(fromFile) ? fromFile : '';
}

async function resolvePublicIp(): Promise<string> {
  const configured = configuredPublicIp();
  if (configured) return configured;
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip']) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const ip = (await r.text()).trim();
      if (isIP(ip)) return ip;
    } catch { /* try next */ }
  }
  throw new Error('无法自动获取公网 IP，请在 .env 设置 QINGYU_PUBLIC_IP');
}

function readEnv(): string {
  try { return fs.readFileSync(ENV_FILE, 'utf8'); } catch { return ''; }
}

function envValue(text: string, key: string): string {
  const re = new RegExp(`^${key}=(.*)$`, 'm');
  return re.exec(text)?.[1]?.trim() || '';
}

function parseAliases(value: string): string[] {
  return String(value || '').split(/\s+/).map((x) => x.trim()).filter(Boolean);
}

/** 配置可能来自旧 .env：优先 APP_BIND，其次 Agent 的 APP_PORT，最后才用默认值。 */
function hostAppPort(text: string): number {
  const bind = envValue(text, 'APP_BIND') || String(process.env.APP_BIND || '');
  const port = Number(bind.split(':').pop());
  return Number.isInteger(port) && port > 0 ? port : APP_PORT;
}

async function status(): Promise<DomainStatus> {
  const text = readEnv();
  const primary = envValue(text, 'SITE_DOMAIN');
  const aliases = parseAliases(envValue(text, 'SITE_ALIASES'));
  let publicIp = '';
  try { publicIp = await resolvePublicIp(); } catch { /* reported below */ }
  let dns: DomainStatus['dns'] = [];
  if (primary) {
    try {
      const checked = await verifyDns(normalizeDomains({ primary, aliases }), publicIp, resolver);
      dns = checked.records;
    } catch { /* malformed legacy env */ }
  }
  const profiles = envValue(text, 'COMPOSE_PROFILES') || ENV_PROFILES;
  const enabled = Boolean(primary) && profiles.split(/[\s,]+/).includes('domain');
  const httpsReady = enabled ? await probeHttps(primary).catch(() => false) : false;
  return {
    ok: true,
    available: true,
    agentOnline: true,
    enabled,
    primary,
    aliases,
    publicIp,
    httpsReady,
    dns,
    activeJob: activeJob() ? publicJob(activeJob()!) : null,
    message: publicIp ? '' : '无法确定服务器公网 IP'
  };
}

let hostProjectDir: string | null = null;

/**
 * Docker socket 属于宿主机，Compose 里的 bind mount 不能使用容器内的 /project。
 * 优先使用 Compose 注入的宿主机路径；升级前没有该变量时，从 Agent 自身的
 * /project 挂载反查 Source。反查结果是 Docker daemon 可识别的宿主机路径，
 * 因此 Linux 与 Docker Desktop 都不需要用户手工猜路径。
 */
async function resolveHostProjectDir(): Promise<string> {
  if (hostProjectDir) return hostProjectDir;
  const configured = String(process.env.QINGYU_HOST_PROJECT_DIR || '').trim();
  if (configured) {
    hostProjectDir = configured;
    return configured;
  }
  const container = String(process.env.HOSTNAME || '').trim();
  if (container) {
    try {
      const { stdout } = await exec('docker', [
        'inspect', '--format',
        `{{range .Mounts}}{{if eq .Destination "${ROOT}"}}{{.Source}}{{end}}{{end}}`,
        container
      ], { timeout: 10_000, maxBuffer: 1024 * 1024 });
      const source = stdout.trim();
      if (source && (path.isAbsolute(source) || /^[A-Za-z]:[\\/]/.test(source))) {
        hostProjectDir = source;
        return source;
      }
    } catch { /* fall through with an explicit error */ }
  }
  throw new Error('无法确定宿主机项目目录；请在 .env 设置 QINGYU_HOST_PROJECT_DIR');
}

async function probeHttps(domain: string): Promise<boolean> {
  try {
    const r = await fetch(`https://${domain}/healthz`, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
    return r.ok || (r.status >= 300 && r.status < 400);
  } catch { return false; }
}

async function dockerCompose(args: string[], timeout = 120_000): Promise<string> {
  const hostRoot = await resolveHostProjectDir();
  const composeArgs = [
    'compose', '--project-directory', ROOT, '-f', path.join(ROOT, 'compose.yaml'),
    '--env-file', ENV_FILE, ...args
  ];
  const { stdout } = await exec('docker', composeArgs, {
    cwd: ROOT,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME || 'qingyu-universal',
      QINGYU_PROJECT_DIR: ROOT,
      QINGYU_ENV_FILE: ENV_FILE,
      QINGYU_HOST_PROJECT_DIR: hostRoot,
      APP_PORT: String(APP_PORT)
    }
  });
  return stdout;
}

function writeEnvAtomic(next: string): { original: Buffer; mode: number } {
  const original = fs.readFileSync(ENV_FILE);
  const stat = fs.statSync(ENV_FILE);
  const tmp = `${ENV_FILE}.domain-agent-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, next, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, ENV_FILE);
  return { original, mode: stat.mode & 0o777 };
}

function restoreEnv(original: Buffer, mode: number): void {
  const tmp = `${ENV_FILE}.domain-agent-restore-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, original, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, ENV_FILE);
}

function withEnv(text: string, updates: Record<string, string>): string {
  return mergeEnvText(text, updates);
}

async function applyDomain(body: { primary: string; aliases?: string[] }, kind: 'enable' | 'update'): Promise<void> {
  const domains = normalizeDomains(body);
  const publicIp = await resolvePublicIp();
  const checked = await verifyDns(domains, publicIp, resolver);
  if (!checked.ok) throw new Error(checked.error || 'DNS 验证失败');

  const originalText = readEnv();
  if (!originalText) throw new Error(`找不到 .env：${ENV_FILE}`);
  const original = fs.readFileSync(ENV_FILE);
  const mode = fs.statSync(ENV_FILE).mode & 0o777;
  const updates = domainEnvUpdates({
    enable: true,
    primary: domains.primary,
    aliases: domains.aliases,
    publicIp,
    appPort: hostAppPort(originalText),
    currentProfiles: envValue(originalText, 'COMPOSE_PROFILES') || ENV_PROFILES
  });
  const next = withEnv(originalText, updates);
  const snapshot = writeEnvAtomic(next);
  fs.writeFileSync(path.join(STATE_DIR, 'env.before-' + Date.now() + '.bak'), snapshot.original, { mode: snapshot.mode });
  try {
    await dockerCompose(['up', '-d', 'app', 'caddy'], 180_000);
    const ready = await waitHttps(domains.primary);
    if (!ready) throw new Error(`HTTPS 验证失败：https://${domains.primary}/healthz 未通过`);
  } catch (e) {
    restoreEnv(original, mode);
    try { await dockerCompose(['up', '-d', 'app', 'caddy'], 180_000); } catch { /* best effort */ }
    throw e;
  }
}

async function waitHttps(domain: string): Promise<boolean> {
  for (let i = 0; i < 24; i++) {
    if (await probeHttps(domain)) return true;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

async function disableDomain(clearDomains: boolean): Promise<void> {
  const originalText = readEnv();
  if (!originalText) throw new Error(`找不到 .env：${ENV_FILE}`);
  const original = fs.readFileSync(ENV_FILE);
  const mode = fs.statSync(ENV_FILE).mode & 0o777;
  let publicIp = envValue(originalText, 'QINGYU_PUBLIC_IP');
  if (isIP(publicIp) === 0) publicIp = configuredPublicIp();
  if (isIP(publicIp) === 0) {
    try { publicIp = new URL(envValue(originalText, 'SITE_URL')).hostname; } catch { /* keep fallback */ }
  }
  if (isIP(publicIp) === 0) {
    try { publicIp = await resolvePublicIp(); } catch { /* explicit error below */ }
  }
  if (!publicIp) throw new Error('无法确定服务器地址；请在 .env 设置 QINGYU_PUBLIC_IP');
  const updates = domainEnvUpdates({
    enable: false,
    clearDomains,
    primary: envValue(originalText, 'SITE_DOMAIN'),
    aliases: parseAliases(envValue(originalText, 'SITE_ALIASES')),
    publicIp,
    appPort: hostAppPort(originalText),
    currentProfiles: envValue(originalText, 'COMPOSE_PROFILES') || ENV_PROFILES
  });
  const snapshot = writeEnvAtomic(withEnv(originalText, updates));
  fs.writeFileSync(path.join(STATE_DIR, 'env.before-' + Date.now() + '.bak'), snapshot.original, { mode: snapshot.mode });
  try {
    // 关闭 domain profile 后必须显式停掉 Caddy，再重建 app 的直连端口映射。
    // 只写 COMPOSE_PROFILES 不会让已经在跑的 Caddy 自己退出。
    try { await dockerCompose(['--profile', 'domain', 'stop', 'caddy'], 180_000); }
    catch { /* 首次部署可能从未创建过 Caddy */ }
    // 不能写 'app caddy'：显式指定带 profile 的服务会绕过 profile 开关。
    // 先停 Caddy，再只重建 app，确保 raw HTTP 端口重新发布到宿主机。
    await dockerCompose(['up', '-d', 'app'], 180_000);
  } catch (e) {
    restoreEnv(original, mode);
    try { await dockerCompose(['up', '-d', 'app', 'caddy'], 180_000); } catch { /* best effort */ }
    throw e;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Bearer ') || !isSafeToken(auth.slice(7))) {
      json(res, 401, { error: '未授权' });
      return;
    }
    const url = new URL(req.url || '/', 'http://domain-agent');
    if (req.method === 'GET' && url.pathname === '/status') {
      json(res, 200, await status());
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/jobs/')) {
      const id = decodeURIComponent(url.pathname.slice('/jobs/'.length));
      const job = jobs.find((x) => x.id === id);
      if (!job) { json(res, 404, { error: '任务不存在' }); return; }
      json(res, 200, { ok: true, job: publicJob(job) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/verify') {
      if (activeJob()) { json(res, 409, { error: '已有域名任务正在执行' }); return; }
      const body = await readBody(req) as { primary?: string; aliases?: string[] };
      const domains = normalizeDomains({ primary: String(body.primary || ''), aliases: body.aliases });
      const job = createJob('verify');
      enqueue(job, async () => {
        const publicIp = await resolvePublicIp();
        const checked = await verifyDns(domains, publicIp, resolver);
        updateJob(job, { publicIp, dns: checked.records });
        if (!checked.ok) throw new Error(checked.error || 'DNS 验证失败');
        return { message: 'DNS 验证通过：所有域名均指向本机公网 IP' };
      });
      json(res, 202, { ok: true, job: publicJob(job) });
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/update' || url.pathname === '/disable' || url.pathname === '/remove')) {
      if (activeJob()) { json(res, 409, { error: '已有域名任务正在执行' }); return; }
      const isRemove = url.pathname === '/remove';
      const isDisable = url.pathname === '/disable';
      const body = isRemove || isDisable ? {} : await readBody(req) as { primary?: string; aliases?: string[]; kind?: 'enable' | 'update' };
      const kind: DomainJob['kind'] = isRemove ? 'remove' : (isDisable ? 'disable' : (body.kind === 'update' ? 'update' : 'enable'));
      const job = createJob(kind);
      enqueue(job, async () => {
        if (isRemove || isDisable) {
          await disableDomain(isRemove);
          return { message: isRemove ? '已移除域名配置，并恢复 HTTP 直连' : '已关闭 HTTPS，并保留已保存的域名；可随时重新启用' };
        }
        await applyDomain({ primary: String(body.primary || ''), aliases: body.aliases }, kind === 'update' ? 'update' : 'enable');
        return { message: 'HTTPS 已启用：https://' + canonicalDomain(String(body.primary || '')) };
      });
      json(res, 202, { ok: true, job: publicJob(job) });
      return;
    }
    json(res, 404, { error: '接口不存在' });
  } catch (e) {
    const message = e instanceof DomainValidationError ? e.message : (e as Error)?.message || String(e);
    json(res, 400, { error: message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[domain-agent] listening on :${PORT}`);
});

function shutdown(signal: string): void {
  console.log('[domain-agent] received ' + signal + ', waiting for queued jobs');
  server.close(() => process.exit(0));
  queue.finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 30_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
