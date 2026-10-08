/* ============================================================
 * 导入 ↔ 导出 往返无损护栏
 * ------------------------------------------------------------
 * 后台「迁移」页是本站唯一一处「用户把数据搬出去、再搬回来」的地方：
 *   Markdown（front matter + 正文） / JSON（posts.json） / ZIP（每篇 .md + posts.json）
 *
 * 「双向都有相应」的最低标准不是「两个按钮都在」，而是**导出的东西能被
 * 原样导回来**：字段不丢、不改名、不串行。所以这里做三种格式的往返比对。
 *
 * 只测纯函数（postToMarkdown / parseMarkdown / backupJson / parseJson /
 * zipForPosts），不去碰 download* —— 那些依赖 document，属于浏览器侧。
 * ============================================================ */
import { describe, expect, it } from 'vitest';
import {
  backupJson,
  parseJson,
  parseMarkdown,
  postToMarkdown,
  zipForPosts,
  type TransferPost
} from '../admin/src/lib/transfer.js';

/** 覆盖各种「刁钻」字段：中文标签、空系列、定时发布、受保护、SEO、多重换行。 */
const SAMPLE: TransferPost = {
  id: 'p-round-trip',
  title: '往返测试 · 标题里有 · 中点',
  date: '2026-03-04T05:06:07.000Z',
  excerpt: '一句话摘要，带 **Markdown** 与 `代码`',
  cover: 'https://example.com/cover.png',
  ogImage: 'https://example.com/og.png',
  category: '随笔',
  series: '从零搭建博客',
  seriesOrder: 2,
  author: '往返机器人',
  status: 'published',
  pinned: true,
  protected: false,
  tags: ['中文标签', 'a,b 逗号标签', '含"引号"'],
  seo: { title: 'SEO 标题', desc: 'SEO 描述' },
  content: '# 一级\n\n正文第一段。\n\n```js\nconst a = 1;\n```\n\n> 引用\n'
} as TransferPost;

const SAMPLE_SCHEDULED: TransferPost = {
  ...SAMPLE,
  id: 'p-scheduled',
  title: '定时发布的文章',
  status: 'scheduled',
  publishAt: 1800000000000
} as TransferPost;

/** 逐字段比对：只看「往返后是否还在」，容忍 null ↔ undefined 的差异。 */
function expectSameFields(original: TransferPost, back: TransferPost, ignore: string[] = []): void {
  for (const [key, value] of Object.entries(original)) {
    if (ignore.includes(key)) continue;
    const actual = (back as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      expect(actual, `${key} 数组不一致`).toEqual(value);
    } else if (value && typeof value === 'object') {
      expect(JSON.stringify(actual), `${key} 对象不一致`).toBe(JSON.stringify(value));
    } else if (value === '' || value === null || value === undefined || value === false) {
      // 空值允许导回时缺失
      if (actual !== undefined && actual !== null && actual !== '') {
        expect(actual, `${key} 空值被改写`).toBeFalsy();
      }
    } else {
      expect(actual, `${key} 不一致`).toEqual(value);
    }
  }
}

describe('Markdown 往返', () => {
  it('导出 → 导入：标题 / 日期 / 标签 / 系列 / 正文全部回来', () => {
    const md = postToMarkdown(SAMPLE);
    expect(md).toContain('title:');
    const back = parseMarkdown(md, 'p-round-trip.md');
    expect(back, '解析失败').not.toBeNull();
    expect(back!.id).toBe(SAMPLE.id);
    expect(back!.title).toBe(SAMPLE.title);
    expect(back!.date).toBe(SAMPLE.date);
    expect(JSON.stringify(back!.tags)).toBe(JSON.stringify(SAMPLE.tags));
    expect(back!.series).toBe(SAMPLE.series);
    // 正文里的代码块必须原样回来（front matter 与正文的分隔是最容易串的地方）
    expect(String(back!.content)).toContain('```js');
    expect(String(back!.content)).toContain('一级');
  });

  it('已知缺口：Markdown 导出不写 author（与上游 stringKeys 一致）', () => {
    const md = postToMarkdown(SAMPLE);
    // 上游 transferPostMarkdown() 的 stringKeys = id/title/date/excerpt/cover/
    // og_image/category/series，没有 author；本版逐字移植，不擅自加字段
    expect(md).not.toContain('author:');
  });

  it('带 publishAt 的定时文章也能往返', () => {
    const md = postToMarkdown(SAMPLE_SCHEDULED);
    const back = parseMarkdown(md, 'p-scheduled.md');
    expect(back).not.toBeNull();
    expect(back!.status).toBe('scheduled');
    expect(Number(back!.publishAt)).toBe(SAMPLE_SCHEDULED.publishAt);
  });
});

/** 从 ZIP 的中央目录里读出条目名（比本地文件头可靠：名字长度是显式字段）。 */
function zipNames(buf: Buffer): string[] {
  const names: string[] = [];
  let i = 0;
  for (;;) {
    const at = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), i);
    if (at < 0) break;
    const nameLen = buf.readUInt16LE(at + 28);
    names.push(buf.toString('utf8', at + 46, at + 46 + nameLen));
    i = at + 4;
  }
  return names;
}

describe('JSON 往返', () => {
  it('导出 → 导入：整批文章字段一致', () => {
    const text = backupJson([SAMPLE, SAMPLE_SCHEDULED]);
    const back = parseJson(text);
    expect(back.length).toBe(2);
    // 已知缺口（与上游同源，不是本版独有）：normalizePost() 不保留 author 与 seo。
    // 上游 app/public/admin.js 的 transferPostMarkdown() 的 stringKeys 里没有 author，
    // transferNormalizePost() 的返回对象里也没有 author / seo —— 两版行为一致，
    // 这里显式钉住，避免有人"顺手补上"后与 Cloudflare 版分叉。
    const IGNORED_BY_UPSTREAM = ['author', 'seo'];
    expectSameFields(SAMPLE, back[0], IGNORED_BY_UPSTREAM);
    expectSameFields(SAMPLE_SCHEDULED, back[1], IGNORED_BY_UPSTREAM);
  });

  it('已知缺口：author / seo 在导入时被丢弃（与上游同行为）', () => {
    const back = parseJson(backupJson([SAMPLE]));
    expect(back[0].author).toBeUndefined();
    // 反向钉住：哪天它回来了，说明我们与上游分叉了，需要回到上面的注释重新决策
    expect((back[0] as Record<string, unknown>).seo).toBeUndefined();
  });

  it('空数组导出后也能被解析回来', () => {
    const back = parseJson(backupJson([]));
    expect(back).toEqual([]);
  });
});

describe('ZIP 往返', () => {
  it('导出 ZIP 里既有每篇 .md，也有汇总 posts.json', async () => {
    const blob = zipForPosts([SAMPLE, SAMPLE_SCHEDULED]);
    const buf = Buffer.from(await blob.arrayBuffer());
    const names = zipNames(buf);
    expect(names.some((n) => n.endsWith('posts.json')), `清单里应有 posts.json，实际：${names.join(', ')}`).toBe(true);
    expect(names.filter((n) => n.endsWith('.md')).length).toBe(2);
  });

  it('ZIP 里的 posts.json 能被 parseJson 原样读回（导入侧真的消费它）', async () => {
    const blob = zipForPosts([SAMPLE, SAMPLE_SCHEDULED]);
    const buf = Buffer.from(await blob.arrayBuffer());
    // 取中央目录里第一条 posts.json 的偏移与长度，把内容抠出来喂给 parseJson
    let at = 0;
    let entry: { off: number; len: number } | null = null;
    for (;;) {
      const i = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), at);
      if (i < 0) break;
      const nameLen = buf.readUInt16LE(i + 28);
      const name = buf.toString('utf8', i + 46, i + 46 + nameLen);
      if (name.endsWith('posts.json')) {
        // 中央目录：+42 压缩后大小(4) → 实际用 +24 后的相对偏移（本地头偏移在 +42）
        const compSize = buf.readUInt32LE(i + 20);
        const localOff = buf.readUInt32LE(i + 42);
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        entry = { off: localOff + 30 + lNameLen + lExtraLen, len: compSize };
        break;
      }
      at = i + 4;
    }
    expect(entry, 'ZIP 里没找到 posts.json').not.toBeNull();
    const text = buf.toString('utf8', entry!.off, entry!.off + entry!.len);
    const back = parseJson(text);
    expect(back.length).toBe(2);
    expect(back[0].title).toBe(SAMPLE.title);
    expect(JSON.stringify(back[0].tags)).toBe(JSON.stringify(SAMPLE.tags));
  });
});
