/* ============================================================
 * 生成类型的可用性验证
 * ------------------------------------------------------------
 * 证明「契约 → OpenAPI → 客户端类型」这条链路真的闭环：
 * 用生成的类型写一个类型安全的取数函数，再配合 tsconfig.test.json
 * 做编译期检查（npm run typecheck:tests），确保类型不是摆设。
 * ============================================================ */
import { afterAll, beforeAll, describe, expect, it, expectTypeOf } from 'vitest';
import { startTestServer, type TestServer } from './helpers/server.js';
import type { components, paths } from '../generated/api.js';

type PostSummary = components['schemas']['PostSummary'];
type PostListResponse = paths['/api/posts']['get']['responses'][200]['content']['application/json'];
type SearchResponse = paths['/api/search']['get']['responses'][200]['content']['application/json'];

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server?.close();
});

/** 一个用生成类型标注的最小取数函数——去掉类型标注它也能跑，但就失去了意义。 */
async function getPosts(): Promise<PostListResponse> {
  const response = await fetch(`${server.baseUrl}/api/posts`);
  return (await response.json()) as PostListResponse;
}

describe('生成的客户端类型', () => {
  it('类型可标注真实响应，且字段可访问', async () => {
    const data = await getPosts();

    expect(data.ok).toBe(true);
    expect(Array.isArray(data.posts)).toBe(true);

    const first: PostSummary | undefined = data.posts[0];
    if (first) {
      expect(typeof first.id).toBe('string');
      expect(typeof first.pinned).toBe('boolean');
      expect(Array.isArray(first.tags)).toBe(true);
    }
  });

  it('类型结构符合预期（编译期断言）', () => {
    expectTypeOf<PostListResponse['posts']>().toEqualTypeOf<PostSummary[]>();
    expectTypeOf<PostSummary['pinned']>().toEqualTypeOf<boolean>();
    expectTypeOf<PostSummary['publishAt']>().toEqualTypeOf<number | null>();
    expectTypeOf<SearchResponse['engine']>().toEqualTypeOf<string>();

    // 可空字段确实被标注为可空
    expectTypeOf<PostSummary['search']>().toEqualTypeOf<string | undefined>();
  });

  it('契约中的字段名与真实响应一致（防止手写类型漂移）', async () => {
    const data = await getPosts();
    const keys = Object.keys(data);
    // 顶层必须是 ok + posts，多一个少一个都说明契约过期了
    expect(keys.sort()).toEqual(['ok', 'posts']);
  });

  it('检索接口的类型同样可用', async () => {
    const response = await fetch(`${server.baseUrl}/api/search?q=${encodeURIComponent('测试')}`);
    const data = (await response.json()) as SearchResponse;
    expectTypeOf(data.total).toEqualTypeOf<number>();
    expectTypeOf(data.hasMore).toEqualTypeOf<boolean>();
    expect(Array.isArray(data.results)).toBe(true);
  });
});