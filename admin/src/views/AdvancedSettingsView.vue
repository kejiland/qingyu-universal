<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Save, Loader2, Info } from '@lucide/vue';
import { api, ApiError } from '../lib/api';
import { toast } from '../lib/toast';

const loading = ref(true);
const saving = ref(false);

const site = ref({
  name: '', desc: '', avatar: '', copyright: '', footerText: '',
  startYear: '', icp: '', about: '',
  announceEnabled: false, announceText: '', announceLink: '', announceLinkText: '', announceClosable: true
});
const profile = ref({ name: '', bio: '', avatar: '', email: '' });
const navText = ref('[]');
const footerNavText = ref('[]');
const linksText = ref('[]');
const adsText = ref('{}');
const features = ref({ pageSize: 8, errorReport: true, commentGuard: true, richContent: true, navExtras: true });
const moderate = ref(false);
const blocklist = ref('');

function safeParse(raw: unknown, fallback: unknown): unknown {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 顶部导航默认项版本：与上游旧后台保持一致 */
const NAV_DEFAULTS_VERSION = 1;
/** 与上游一致的内置导航默认项（text 留空，前台按 i18n key 自动翻译） */
const DEFAULT_NAV_ITEMS = [
  { i18n: 'nav.home', text: '', url: '/' },
  { i18n: 'nav.tags', text: '', url: '/tags' },
  { i18n: 'nav.categories', text: '', url: '/categories' },
  { i18n: 'nav.history', text: '', url: '/history' },
  { i18n: 'nav.series', text: '', url: '/series' },
  { i18n: 'nav.popular', text: '', url: '/popular' },
  { i18n: 'nav.archive', text: '', url: '/archive' },
  { i18n: 'nav.guestbook', text: '', url: '/guestbook' },
  { i18n: 'nav.about', text: '', url: '/about' }
];

function navUrlKey(item: { url?: string }): string {
  const u = String(item?.url || '/').replace(/^#/, '');
  if (u.charAt(0) !== '/') return u;
  return u.replace(/\/+$/, '') || '/';
}

/** 旧配置首次加载时补齐新增的默认导航项（用户删除过的不会在保存后被加回） */
function mergeDefaultNav(items: unknown): unknown[] {
  if (!Array.isArray(items)) return [];
  if (!items.length) return items;
  const out = items.slice() as { url?: string }[];
  const order: Record<string, number> = {};
  DEFAULT_NAV_ITEMS.forEach((it, i) => { order[navUrlKey(it)] = i; });
  for (const def of DEFAULT_NAV_ITEMS) {
    const key = navUrlKey(def);
    if (out.some((it) => navUrlKey(it) === key)) continue;
    let insertAt = out.length;
    for (let i = 0; i < out.length; i++) {
      const curKey = navUrlKey(out[i]);
      const curOrder = Object.prototype.hasOwnProperty.call(order, curKey) ? order[curKey] : Infinity;
      if (curOrder > order[key]) { insertAt = i; break; }
    }
    out.splice(insertAt, 0, def);
  }
  return out;
}

onMounted(async () => {
  try {
    const { settings } = await api.getSettings();
    const siteObj = {
      ...asObject(safeParse(settings.site_info, {})),
      ...asObject(safeParse(settings.site, {}))
    };
    const footer = asObject(safeParse(settings.footer, {}));
    const prof = asObject(safeParse(settings.profile, {}));
    const featureObj = asObject(safeParse(settings.features, {}));

    site.value = {
      name: String(siteObj.name ?? ''),
      desc: String(siteObj.desc ?? ''),
      avatar: String(siteObj.avatar ?? ''),
      copyright: String(siteObj.copyright ?? footer.copyrightName ?? ''),
      footerText: String(siteObj.footerText ?? footer.decl ?? ''),
      startYear: String(footer.startYear ?? ''),
      icp: String(footer.icp ?? ''),
      about: String(siteObj.about ?? ''),
      announceEnabled: siteObj.announceEnabled === true,
      announceText: String(siteObj.announceText ?? ''),
      announceLink: String(siteObj.announceLink ?? ''),
      announceLinkText: String(siteObj.announceLinkText ?? ''),
      announceClosable: siteObj.announceClosable !== false
    };
    profile.value = {
      name: String(prof.name ?? ''),
      bio: String(prof.bio ?? ''),
      avatar: String(prof.avatar ?? ''),
      email: String(prof.email ?? '')
    };
    let navItems = safeParse(settings.nav_menu, safeParse(settings.nav, []));
    if (Number(settings.nav_defaults_version || 0) < NAV_DEFAULTS_VERSION) navItems = mergeDefaultNav(navItems);
    navText.value = JSON.stringify(navItems, null, 2);
    footerNavText.value = JSON.stringify(safeParse(settings.footer_nav, []), null, 2);
    linksText.value = JSON.stringify(safeParse(settings.friend_links, arr(footer.links)), null, 2);
    adsText.value = JSON.stringify(asObject(featureObj.ads), null, 2);
    features.value = {
      pageSize: Number(featureObj.pageSize) || 8,
      errorReport: featureObj.errorReport !== false,
      commentGuard: featureObj.commentGuard !== false,
      richContent: featureObj.richContent !== false,
      navExtras: featureObj.navExtras !== false
    };
    moderate.value = settings.moderate_comments === '1';
    blocklist.value = String(settings.comment_blocklist ?? '');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '加载高级设置失败');
  } finally {
    loading.value = false;
  }
});

function parseEditor(text: string, label: string, array: boolean): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text || (array ? '[]' : '{}'));
  } catch {
    throw new Error(`${label} 不是合法 JSON`);
  }
  if (array && !Array.isArray(value)) throw new Error(`${label} 必须是 JSON 数组`);
  if (!array && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error(`${label} 必须是 JSON 对象`);
  return value;
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const nav = parseEditor(navText.value, '导航菜单', true);
    const footerNav = parseEditor(footerNavText.value, '页脚导航', true);
    const links = parseEditor(linksText.value, '友链', true);
    const ads = parseEditor(adsText.value, '广告位', false);

    const sitePayload = { ...site.value };
    const footerPayload = {
      copyrightName: site.value.copyright,
      startYear: site.value.startYear,
      icp: site.value.icp,
      decl: site.value.footerText,
      links
    };
    const navJson = JSON.stringify(nav);
    const featurePayload = { ...features.value, pageSize: Number(features.value.pageSize) || 8, ads };

    await api.saveSettings({
      site: sitePayload,
      site_info: sitePayload,
      footer: footerPayload,
      profile: { ...profile.value },
      nav: navJson,
      nav_menu: navJson,
      nav_defaults_version: String(NAV_DEFAULTS_VERSION),
      footer_nav: JSON.stringify(footerNav),
      friend_links: JSON.stringify(links),
      features: featurePayload,
      moderate_comments: moderate.value ? '1' : '0',
      comment_blocklist: blocklist.value
    });
    toast.success('高级设置已保存');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : e instanceof Error ? e.message : '保存失败');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div v-if="loading" class="card h-64 shimmer" />

  <div v-else class="space-y-6">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-[20px] font-semibold">高级设置</h1>
        <p class="text-[13px] text-ink-muted mt-1">导航、页脚、公告、功能开关、评论规则与广告位。</p>
      </div>
      <button class="btn btn-primary shrink-0" :disabled="saving" @click="save">
        <Loader2 v-if="saving" :size="16" class="animate-spin" />
        <Save v-else :size="16" />
        <span>{{ saving ? '保存中…' : '保存全部' }}</span>
      </button>
    </div>

    <div class="grid gap-6 xl:grid-cols-2 items-start">
      <section class="card p-5 space-y-4">
        <h2 class="text-[15px] font-semibold">作者资料</h2>
        <div><label class="label" for="profileName">作者名称</label><input id="profileName" v-model="profile.name" class="input" /></div>
        <div><label class="label" for="profileBio">个人简介</label><textarea id="profileBio" v-model="profile.bio" class="textarea" rows="3" /></div>
        <div><label class="label" for="profileAvatar">头像 URL</label><input id="profileAvatar" v-model="profile.avatar" class="input font-mono text-[12px]" placeholder="https://… 或 /media/…" /></div>
        <div><label class="label" for="profileEmail">通知邮箱</label><input id="profileEmail" v-model="profile.email" class="input" type="email" /></div>
      </section>

      <section class="card p-5 space-y-4">
        <h2 class="text-[15px] font-semibold">公告</h2>
        <label class="flex items-center gap-2 text-[13px]"><input v-model="site.announceEnabled" type="checkbox" /> 启用首页公告</label>
        <div><label class="label" for="announceText">公告内容</label><textarea id="announceText" v-model="site.announceText" class="textarea" rows="3" /></div>
        <div class="grid sm:grid-cols-2 gap-4">
          <div><label class="label" for="announceLink">链接地址</label><input id="announceLink" v-model="site.announceLink" class="input" placeholder="/posts/…" /></div>
          <div><label class="label" for="announceLinkText">链接文字</label><input id="announceLinkText" v-model="site.announceLinkText" class="input" placeholder="查看详情" /></div>
        </div>
        <label class="flex items-center gap-2 text-[13px]"><input v-model="site.announceClosable" type="checkbox" /> 允许访客关闭公告</label>
      </section>

      <section class="card p-5 space-y-4">
        <h2 class="text-[15px] font-semibold">页脚与版权</h2>
        <div><label class="label" for="copyright">版权名称</label><input id="copyright" v-model="site.copyright" class="input" /></div>
        <div><label class="label" for="footerText">页脚说明</label><textarea id="footerText" v-model="site.footerText" class="textarea" rows="2" /></div>
        <div class="grid sm:grid-cols-2 gap-4">
          <div><label class="label" for="startYear">建站年份</label><input id="startYear" v-model="site.startYear" class="input" placeholder="2026" /></div>
          <div><label class="label" for="icp">ICP 备案号</label><input id="icp" v-model="site.icp" class="input" /></div>
        </div>
      </section>

      <section class="card p-5 space-y-4">
        <h2 class="text-[15px] font-semibold">功能开关</h2>
        <div><label class="label" for="pageSize">每页文章数</label><input id="pageSize" v-model.number="features.pageSize" class="input" type="number" min="1" max="50" /></div>
        <label class="flex items-center gap-2 text-[13px]"><input v-model="features.errorReport" type="checkbox" /> 允许前台上报错误日志</label>
        <label class="flex items-center gap-2 text-[13px]"><input v-model="features.commentGuard" type="checkbox" /> 启用评论反机器人保护</label>
        <label class="flex items-center gap-2 text-[13px]"><input v-model="features.richContent" type="checkbox" /> 启用增强正文渲染</label>
        <label class="flex items-center gap-2 text-[13px]"><input v-model="features.navExtras" type="checkbox" /> 显示新增导航项（分类 / 历史 / 系列 / 热门）</label>
      </section>

      <section class="card p-5 space-y-4">
        <h2 class="text-[15px] font-semibold">评论规则</h2>
        <label class="flex items-center gap-2 text-[13px]"><input v-model="moderate" type="checkbox" /> 新评论默认进入待审核</label>
        <div>
          <label class="label" for="blocklist">敏感词</label>
          <textarea id="blocklist" v-model="blocklist" class="textarea font-mono text-[12px]" rows="6" placeholder="一行一个，也可用逗号分隔" />
          <p class="hint">命中敏感词的评论会被拒绝。</p>
        </div>
      </section>

      <section class="card p-5 space-y-4">
        <h2 class="text-[15px] font-semibold">导航菜单 JSON</h2>
        <p class="hint">每项包含 text、url，可选 children 子菜单数组。</p>
        <textarea v-model="navText" class="textarea font-mono text-[12px]" rows="10" spellcheck="false" />
      </section>

      <section class="card p-5 space-y-4">
        <h2 class="text-[15px] font-semibold">页脚导航 JSON</h2>
        <textarea v-model="footerNavText" class="textarea font-mono text-[12px]" rows="8" spellcheck="false" />
      </section>

      <section class="card p-5 space-y-4">
        <h2 class="text-[15px] font-semibold">友情链接 JSON</h2>
        <textarea v-model="linksText" class="textarea font-mono text-[12px]" rows="8" spellcheck="false" />
      </section>

      <section class="card p-5 space-y-4">
        <h2 class="text-[15px] font-semibold">广告位 JSON</h2>
        <textarea v-model="adsText" class="textarea font-mono text-[12px]" rows="8" spellcheck="false" />
      </section>
    </div>

    <div class="flex items-start gap-2 rounded-xl border border-line bg-surface-2 px-4 py-3 text-[12.5px] text-ink-muted">
      <Info :size="15" class="text-accent shrink-0 mt-0.5" />
      JSON 编辑器适合高级配置；显示“不是合法 JSON”时请先修正格式再保存，已有设置不会受影响。
    </div>
  </div>
</template>