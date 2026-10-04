/* 导出 OpenAPI 文档到 generated/openapi.json（构建期用，供客户端类型生成）。 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { createApiDocument } from '../api/document.js';

const serverUrl = (process.env.SITE_URL || 'http://localhost:8787').replace(/\/+$/, '');
const document = createApiDocument(serverUrl);

const outDir = path.join(ROOT, 'generated');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'openapi.json');
fs.writeFileSync(outFile, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

const paths = Object.keys(document.paths as Record<string, unknown>);
console.log(`[openapi] 已生成 ${outFile}`);
console.log(`[openapi] ${paths.length} 条路径，${paths.join(', ')}`);
console.log(`[openapi] server: ${serverUrl}`);