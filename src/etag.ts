/* ============================================================
 * ETag 生成
 * ------------------------------------------------------------
 * HTTP 头值必须是 ByteString（每个字符 <= 0xFF）。文章 ID 在中文博客里
 * 常常是中文，直接拼进 ETag 会让 new Headers() 抛
 *   Cannot convert argument to a ByteString because the character at index N ...
 * 用户看到的是整个页面 500，而错误信息与文章内容毫无关系，极难排查。
 *
 * ETag 按规范就是**不透明**的，所以这里统一用哈希：既是纯 ASCII，
 * 又比拼接原文更短。所有自己生成的 ETag 都必须走这个函数。
 * ============================================================ */
import crypto from 'node:crypto';

/** 生成弱 ETag：W/"<16 位十六进制>"。参数任意，内部统一序列化后哈希。 */
export function weakEtag(...parts: Array<string | number | null | undefined>): string {
  const hash = crypto
    .createHash('sha1')
    .update(parts.map((part) => String(part ?? '')).join('\u0000'))
    .digest('hex')
    .slice(0, 16);
  return `W/"${hash}"`;
}
