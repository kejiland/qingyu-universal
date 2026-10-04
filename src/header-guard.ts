/* ============================================================
 * HTTP 头值兜底
 * ------------------------------------------------------------
 * HTTP 头值必须是 ByteString，Node 的 writeHead 遇到超范围字符会直接抛
 *   TypeError [ERR_INVALID_CHAR]: Invalid character in header content ["ETag"]
 * 结果是整页 500，而错误信息与用户内容毫无关系，极难排查。
 *
 * 这类问题在实践中出现过两次（自加的 SSR ETag、上游拼进 Cache-Tag 的文章 ID），
 * 两处都已在源头修好。但源头修不完：上游代码、后续新增代码都可能再犯。
 * 因此这里在写出的最后一道关口做兜底，把非 ASCII 百分号编码 ——
 * 既不再崩溃，也保留了信息。
 *
 * 注意：必须按**码点**遍历。emoji 是代理对，按下标遍历会拿到孤立代理项，
 * encodeURIComponent 对孤立代理项会抛 URIError，换个错误继续 500。
 * ============================================================ */
export function asciiHeaderValue(value: string): string {
  let needsWork = false;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 126 || (code < 32 && code !== 9)) {
      needsWork = true;
      break;
    }
  }
  if (!needsWork) return value;

  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += (code >= 32 && code <= 126) || code === 9 ? ch : encodeURIComponent(ch);
  }
  return out;
}

/** 批量处理响应头：只改值，不改名。 */
export function asciiHeaderEntries(headers: Headers): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  headers.forEach((value, name) => out.push([name, asciiHeaderValue(value)]));
  return out;
}
/**
 * 给响应加兜底：只处理「值里含非 ASCII」的头，全 ASCII 时原样返回（零开销）。
 * Response 的写出由 @hono/node-server 负责，这里是最靠外的可拦截点。
 */
export async function withAsciiHeaders(
  input: Response | Promise<Response>
): Promise<Response> {
  const response = await input;

  let needsWork = false;
  response.headers.forEach((value) => {
    if (asciiHeaderValue(value) !== value) needsWork = true;
  });
  if (!needsWork) return response;

  const headers = new Headers();
  response.headers.forEach((value, name) => headers.set(name, asciiHeaderValue(value)));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
