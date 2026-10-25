import { z } from 'zod';

export const DomainConfigSchema = z.object({
  primary: z.string(),
  aliases: z.array(z.string())
}).meta({ id: 'DomainConfig' });

export const DomainDnsRecordSchema = z.object({
  domain: z.string(),
  addresses: z.array(z.string()),
  matches: z.boolean()
}).meta({ id: 'DomainDnsRecord' });

export const DomainJobSchema = z.object({
  id: z.string(),
  kind: z.enum(['verify', 'enable', 'disable', 'update', 'remove']),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  message: z.string(),
  progress: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  publicIp: z.string().optional(),
  dns: z.array(DomainDnsRecordSchema).optional()
}).meta({ id: 'DomainJob' });

export const DomainStatusResponseSchema = z.object({
  ok: z.literal(true),
  available: z.boolean(),
  agentOnline: z.boolean(),
  enabled: z.boolean(),
  primary: z.string(),
  aliases: z.array(z.string()),
  publicIp: z.string(),
  httpsReady: z.boolean(),
  dns: z.array(DomainDnsRecordSchema),
  activeJob: DomainJobSchema.nullable(),
  message: z.string()
}).meta({ id: 'DomainStatusResponse' });

export const DomainVerifyBodySchema = z.object({
  primary: z.string().min(1),
  aliases: z.array(z.string()).max(20).optional()
}).meta({ id: 'DomainVerifyBody' });

/** PUT 的 kind 只允许 enable/update；省略时由后端按当前状态推断。 */
export const DomainUpdateBodySchema = DomainVerifyBodySchema.extend({
  kind: z.enum(['enable', 'update']).optional()
}).meta({ id: 'DomainUpdateBody' });

export const DomainRemoveBodySchema = z.object({
  mode: z.enum(['disable', 'remove']).default('remove')
}).meta({ id: 'DomainRemoveBody' });

export const DomainActionResponseSchema = z.object({
  ok: z.literal(true),
  job: DomainJobSchema
}).meta({ id: 'DomainActionResponse' });

export const DomainJobParamSchema = z.object({ id: z.string().min(1) });

export const DomainJobResponseSchema = z.object({
  ok: z.literal(true),
  job: DomainJobSchema
}).meta({ id: 'DomainJobResponse' });
