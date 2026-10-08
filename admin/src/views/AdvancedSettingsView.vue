<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { Braces, Plus, Save, Loader2, Info, Tag } from '@lucide/vue';
import ListEditorCard from '../components/ListEditorCard.vue';
import { api, ApiError, type PostSummary } from '../lib/api';
import { toast } from '../lib/toast';
import { t } from '../lib/i18n';

/* ---------- tab 切换（沿用上游设置页的划分）----------
 * 上游是同页 6 个 tab：site / features / profile / nav / footerNav / friends。
 * 这里保持同一套划分与顺序，tab 文案直接用上游词典键（五语自带）。
 * 面板用 v-show 而不是 v-if：数据都在内存 ref 里不会丢，ListEditorCard 的内部状态
 * （比如广告位的 JSON 编辑模式）切走再切回来也还在。 */
const TABS = [
  { key: 'site', labelKey: 'admin.settings.siteInfo' },
  { key: 'features', labelKey: 'admin.settings.features' },
  { key: 'profile', labelKey: 'admin.settings.profile' },
  { key: 'nav', labelKey: 'admin.settings.navMenu' },
  { key: 'footerNav', labelKey: 'admin.settings.footerNav' },
  { key: 'friends', labelKey: 'admin.settings.friendLinks' }
] as const;

const TAB_STORE = 'qingyu.advancedSettingsTab';
const tab = ref<string>(localStorage.getItem(TAB_STORE) || 'site');
if (!TABS.some((it) => it.key === tab.value)) tab.value = 'site';
watch(tab, (v) => {
  try {
    localStorage.setItem(TAB_STORE, v);
  } catch {
    /* 隐私模式下写不了 localStorage，不影响本次会话 */
  }
});

const loading = ref(true);
const saving = ref(false);

/* ---------- 首页标签白名单（site_settings.home_tags） ----------
 * 前台 renderHomeTagRow 会按这份白名单过滤首页标签条；为空 = 显示全部。
 * 语义与上游旧后台一致，存 JSON 数组字符串。 */
const homeTags = ref<string[]>([]);
const tagPool = ref<{ name: string; count: number }[]>([]);
const tagPoolLoading = ref(false);
const customTag = ref('');

/** 可选标签 = 文章里出现过的标签（按用量降序）+ 已选但当前没有文章的标签 */
const tagOptions = computed<{ name: string; count: number }[]>(() => {
  const seen = new Set(tagPool.value.map((t) => t.name));
  const extra = homeTags.value
    .filter((name) => !seen.has(name))
    .map((name) => ({ name, count: 0 }));
  return [...tagPool.value, ...extra];
});

function toggleHomeTag(name: string): void {
  const index = homeTags.value.indexOf(name);
  if (index >= 0) homeTags.value = homeTags.value.filter((t) => t !== name);
  else homeTags.value = [...homeTags.value, name];
}

function addCustomTag(): void {
  const name = customTag.value.trim();
  if (!name) return;
  if (!homeTags.value.includes(name)) homeTags.value = [...homeTags.value, name];
  customTag.value = '';
}

async function loadTagPool(): Promise<void> {
  tagPoolLoading.value = true;
  try {
    const data = await api.listPosts({ all: true });
    const posts: PostSummary[] = data.posts ?? [];
    const map = new Map<string, number>();
    for (const post of posts) {
      for (const raw of post.tags ?? []) {
        const name = String(raw ?? '').trim();
        if (!name) continue;
        map.set(name, (map.get(name) ?? 0) + 1);
      }
    }
    tagPool.value = [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '加载标签列表失败');
  } finally {
    tagPoolLoading.value = false;
  }
}

const site = ref({
  name: '', desc: '', avatar: '', copyright: '', footerText: '',
  startYear: '', icp: '', about: '',
  announceEnabled: false, announceText: '', announceLink: '', announceLinkText: '', announceClosable: true
});
const profile = ref({ name: '', bio: '', avatar: '', email: '' });
const navItems = ref<Record<string, unknown>[]>([]);
const footerNavItems = ref<Record<string, unknown>[]>([]);
const friendLinks = ref<Record<string, unknown>[]>([]);
const ads = ref({
  enabled: false, client: '', belowSearch: '', between: '', betweenEvery: 3, content: ''
});
const adsExtra = ref<Record<string, unknown>>({});
const adsJsonMode = ref(false);
const adsJsonDraft = ref('');
const adsJsonError = ref('');
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

/** 解析成去重后的字符串数组（首页标签白名单用），顺手丢掉空串与重复项 */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    const name = String(raw ?? '').trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** 把任意 JSON 解析成「对象数组」，不是对象的脏数据会被过滤掉 */
function itemList(value: unknown): Record<string, unknown>[] {
  return arr(value)
    .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v))
    .map((v) => ({ ...v }));
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

/* ---------- 顶部导航草稿持久化（与上游 qingyu.settingsNavDraft 一致） ----------
 * 未保存时把编辑中的导航存到本地，刷新 / 切页不丢；保存成功后清除草稿。 */
const NAV_DRAFT_KEY = 'qingyu.settingsNavDraft';
const navLoaded = ref(false);

function loadNavDraft(): unknown[] | null {
  try {
    const raw = localStorage.getItem(NAV_DRAFT_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** 导航项比较用的 url 键（复用 navUrlKey 的归一化规则） */
function navKey(item: Record<string, unknown>): string {
  return navUrlKey({ url: String(item.url ?? '') });
}

/** 以服务端导航为底合并本地草稿：草稿只覆盖文案 / 地址 / 发现开关，并补上新增项 */
function mergeNavDraft(base: Record<string, unknown>[], draft: unknown): Record<string, unknown>[] {
  const incoming = itemList(draft);
  if (!incoming.length) return base;
  const out = base.map((item) => {
    let hit: Record<string, unknown> | undefined;
    for (const di of incoming) {
      if (navKey(di) === navKey(item)) {
        hit = di;
        break;
      }
    }
    const merged = { ...item };
    if (hit) {
      if (hit.text !== undefined) merged.text = hit.text;
      if (hit.url !== undefined) merged.url = hit.url;
      if (hit.discover !== undefined) merged.discover = hit.discover;
    }
    const baseKids = itemList(item.children);
    const draftKids = itemList(hit?.children);
    const kids = baseKids.length ? baseKids : draftKids;
    if (kids.length) merged.children = kids;
    else delete merged.children;
    return merged;
  });
  for (const di of incoming) {
    const key = navKey(di);
    if (out.some((o) => navKey(o) === key)) continue;
    out.push({ ...di });
  }
  return out;
}

function persistNavDraft(): void {
  if (!navLoaded.value) return;
  try {
    localStorage.setItem(NAV_DRAFT_KEY, JSON.stringify(navItems.value));
  } catch {
    /* 隐私模式下忽略 */
  }
}

function clearNavDraft(): void {
  try {
    localStorage.removeItem(NAV_DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

watch(navItems, persistNavDraft, { deep: true });

/* 作者头像预览：URL 变化时重置失败标记，避免旧错误态残留 */
const avatarError = ref(false);
watch(
  () => profile.value.avatar,
  () => {
    avatarError.value = false;
  }
);

onMounted(async () => {
  try {
    const { settings } = await api.getSettings();
    /* 只读 site_info：
     * - `site` 是旧键名，前台读的是 site_info，再让旧值覆盖会盖掉刚保存的新值；
     * - `footer` 不是合法的 site_settings 键（页脚默认取自静态 config.js），
     *   仅当历史库里残留时才用它把早先填过的建站年份 / 备案号回读出来。 */
    const siteObj = asObject(safeParse(settings.site_info, {}));
    const footer = asObject(safeParse(settings.footer, {}));
    const prof = asObject(safeParse(settings.profile, {}));
    const featureObj = asObject(safeParse(settings.features, {}));

    site.value = {
      name: String(siteObj.name ?? ''),
      desc: String(siteObj.desc ?? ''),
      avatar: String(siteObj.avatar ?? ''),
      copyright: String(siteObj.copyright ?? footer.copyrightName ?? ''),
      footerText: String(siteObj.footerText ?? footer.decl ?? ''),
      // 建站年份 / 备案号：优先 site_info（新口径），回退历史 footer 键
      startYear: String(siteObj.startYear ?? footer.startYear ?? ''),
      icp: String(siteObj.icp ?? footer.icp ?? ''),
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
    let navParsed = safeParse(settings.nav_menu, safeParse(settings.nav, []));
    if (Number(settings.nav_defaults_version || 0) < NAV_DEFAULTS_VERSION) navParsed = mergeDefaultNav(navParsed);
    navItems.value = itemList(navParsed);
    // 合并本地未保存草稿（刷新 / 切页不丢），再开启草稿写入
    const savedNavDraft = loadNavDraft();
    if (savedNavDraft) navItems.value = mergeNavDraft(navItems.value, savedNavDraft);
    navLoaded.value = true;
    footerNavItems.value = itemList(safeParse(settings.footer_nav, []));
    friendLinks.value = itemList(safeParse(settings.friend_links, arr(footer.links)));
    const rawAds = asObject(featureObj.ads);
    adsExtra.value = { ...rawAds };
    ads.value = {
      enabled: rawAds.enabled === true,
      client: String(rawAds.client ?? ''),
      belowSearch: String(rawAds.belowSearch ?? ''),
      between: String(rawAds.between ?? ''),
      betweenEvery: Number(rawAds.betweenEvery) || 3,
      content: String(rawAds.content ?? '')
    };
    features.value = {
      pageSize: Number(featureObj.pageSize) || 8,
      errorReport: featureObj.errorReport !== false,
      commentGuard: featureObj.commentGuard !== false,
      richContent: featureObj.richContent !== false,
      navExtras: featureObj.navExtras !== false
    };
    moderate.value = settings.moderate_comments === '1';
    blocklist.value = String(settings.comment_blocklist ?? '');
    homeTags.value = asStringArray(safeParse(settings.home_tags, []));
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '加载高级设置失败');
  } finally {
    loading.value = false;
  }
  void loadTagPool();
});

/** 恢复内置顶部导航（含新增的默认项） */
function resetNav(): void {
  navItems.value = DEFAULT_NAV_ITEMS.map((item) => ({ ...item }));
}

/** 广告位：把表单字段与历史遗留字段合并成前台可读的完整对象 */
function adsToObject(): Record<string, unknown> {
  return {
    ...adsExtra.value,
    enabled: ads.value.enabled,
    client: ads.value.client,
    belowSearch: ads.value.belowSearch,
    between: ads.value.between,
    betweenEvery: Number(ads.value.betweenEvery) || 3,
    content: ads.value.content
  };
}

function openAdsJson(): void {
  adsJsonDraft.value = JSON.stringify(adsToObject(), null, 2);
  adsJsonError.value = '';
  adsJsonMode.value = true;
}

function closeAdsJson(): void {
  adsJsonMode.value = false;
  adsJsonError.value = '';
}

function applyAdsJson(): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(adsJsonDraft.value || '{}');
  } catch {
    adsJsonError.value = '不是合法 JSON，请检查逗号、引号和括号。';
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    adsJsonError.value = '必须是 JSON 对象（最外层用 {} 包裹）。';
    return;
  }
  const obj = parsed as Record<string, unknown>;
  adsExtra.value = { ...obj };
  ads.value = {
    enabled: obj.enabled === true,
    client: String(obj.client ?? ''),
    belowSearch: String(obj.belowSearch ?? ''),
    between: String(obj.between ?? ''),
    betweenEvery: Number(obj.betweenEvery) || 3,
    content: String(obj.content ?? '')
  };
  closeAdsJson();
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const nav = navItems.value;
    const footerNav = footerNavItems.value;
    const links = friendLinks.value;
    const adsPayload = adsToObject();

    /* 建站年份 / 备案号随 site_info 一起存 —— 前台与 SSR 的页脚覆盖链都从 site_info 读，
     * 这样后台填的值才真的会显示出来。
     * 同时不再写这三个键：`site`（旧键名，无人读）、`footer`（不是合法的 site_settings
     * 键）、`nav`（上游迁移 0012_clear_orphaned_nav.sql 已明确清除，且现在没有任何消费点，
     * 前台 app.js:1045 只读 nav_menu）。 */
    const sitePayload = { ...site.value };
    const navJson = JSON.stringify(nav);
    const featurePayload = { ...features.value, pageSize: Number(features.value.pageSize) || 8, ads: adsPayload };

    await api.saveSettings({
      site_info: sitePayload,
      profile: { ...profile.value },
      nav_menu: navJson,
      nav_defaults_version: String(NAV_DEFAULTS_VERSION),
      footer_nav: JSON.stringify(footerNav),
      friend_links: JSON.stringify(links),
      home_tags: JSON.stringify(homeTags.value),
      features: featurePayload,
      moderate_comments: moderate.value ? '1' : '0',
      comment_blocklist: blocklist.value
    });
    clearNavDraft();
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
      <div class="flex flex-wrap items-center justify-end gap-3">
        <p class="hint mr-auto">六个页签沿用上游设置页的划分；「保存全部」会一次写入所有页签的改动。</p>
        <button class="btn btn-primary shrink-0" :disabled="saving" @click="save">
          <Loader2 v-if="saving" :size="16" class="animate-spin" />
          <Save v-else :size="16" />
          <span>{{ saving ? '保存中…' : '保存全部' }}</span>
        </button>
      </div>

    <div class="ab-tabs" role="tablist">
      <button
        v-for="it in TABS"
        :key="it.key"
        type="button"
        role="tab"
        class="ab-tab"
        :class="{ active: tab === it.key }"
        :aria-selected="tab === it.key"
        @click="tab = it.key"
      >{{ t(it.labelKey) }}</button>
    </div>

    <!-- 站点：公告 / 页脚与版权 / 评论规则（对应上游 site tab） -->
    <div v-show="tab === 'site'" data-tab-panel="site" class="grid gap-6 xl:grid-cols-2 items-start">
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
        <h2 class="text-[15px] font-semibold">评论规则</h2>
        <label class="flex items-center gap-2 text-[13px]"><input v-model="moderate" type="checkbox" /> 新评论默认进入待审核</label>
        <div>
          <label class="label" for="blocklist">敏感词</label>
          <textarea id="blocklist" v-model="blocklist" class="textarea font-mono text-[12px]" rows="6" placeholder="一行一个，也可用逗号分隔" />
          <p class="hint">命中敏感词的评论会被拒绝。</p>
        </div>
      </section>
    </div>

    <!-- 功能：功能开关 / 首页标签 / 广告位（对应上游 features tab） -->
    <div v-show="tab === 'features'" data-tab-panel="features" class="grid gap-6 xl:grid-cols-2 items-start">
      <section class="card p-5 space-y-4">
        <h2 class="text-[15px] font-semibold">功能开关</h2>
        <div><label class="label" for="pageSize">每页文章数</label><input id="pageSize" v-model.number="features.pageSize" class="input" type="number" min="1" max="50" /></div>
        <label class="flex items-center gap-2 text-[13px]"><input v-model="features.errorReport" type="checkbox" /> 允许前台上报错误日志</label>
        <label class="flex items-center gap-2 text-[13px]"><input v-model="features.commentGuard" type="checkbox" /> 启用评论反机器人保护</label>
        <label class="flex items-center gap-2 text-[13px]"><input v-model="features.richContent" type="checkbox" /> 启用增强正文渲染</label>
        <label class="flex items-center gap-2 text-[13px]"><input v-model="features.navExtras" type="checkbox" /> 显示新增导航项（分类 / 历史 / 系列 / 热门）</label>
      </section>

      <section class="card p-5 space-y-4">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h2 class="text-[15px] font-semibold">首页显示的标签</h2>
            <p class="hint mt-1">勾选首页标签条要显示的标签，不选则显示全部。</p>
          </div>
          <button
            v-if="homeTags.length"
            class="btn btn-sm btn-ghost shrink-0"
            type="button"
            @click="homeTags = []"
          >
            全部显示
          </button>
        </div>

        <p v-if="tagPoolLoading" class="hint">正在统计文章标签…</p>
        <template v-else>
          <p v-if="!tagOptions.length" class="hint">还没有任何标签，发布文章并添加标签后即可在这里勾选。</p>
          <div v-else class="flex flex-wrap gap-1.5">
            <button
              v-for="opt in tagOptions"
              :key="opt.name"
              type="button"
              class="btn btn-sm"
              :class="homeTags.includes(opt.name) ? 'btn-primary' : 'btn-ghost'"
              @click="toggleHomeTag(opt.name)"
            >
              <Tag :size="13" />
              <span>{{ opt.name }}</span>
              <span v-if="opt.count" class="opacity-70">{{ opt.count }}</span>
            </button>
          </div>
        </template>

        <div class="flex flex-wrap items-end gap-2">
          <div class="min-w-[200px] flex-1">
            <label class="label" for="customHomeTag">手动补充标签</label>
            <input
              id="customHomeTag"
              v-model="customTag"
              class="input"
              placeholder="暂时还没有文章使用的标签"
              @keydown.enter.prevent="addCustomTag"
            />
          </div>
          <button class="btn btn-sm btn-secondary" type="button" @click="addCustomTag">
            <Plus :size="14" />
            <span>加入白名单</span>
          </button>
        </div>

        <p class="hint">
          已选 {{ homeTags.length }} 个标签；白名单里的标签必须真的被文章使用才会显示在首页。
        </p>
      </section>

      <section class="card p-5 space-y-4">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h2 class="text-[15px] font-semibold">广告位</h2>
            <p class="hint mt-1">AdSense 与列表 / 正文广告代码，留空则不展示。</p>
          </div>
          <button
            class="btn btn-sm btn-ghost shrink-0"
            type="button"
            :title="adsJsonMode ? '返回表单编辑' : '查看 JSON'"
            @click="adsJsonMode ? closeAdsJson() : openAdsJson()"
          >
            <Braces :size="14" />
            <span>{{ adsJsonMode ? '表单' : 'JSON' }}</span>
          </button>
        </div>

        <template v-if="!adsJsonMode">
          <label class="flex items-center gap-2 text-[13px]"><input v-model="ads.enabled" type="checkbox" /> 启用广告</label>
          <div>
            <label class="label" for="adsClient">AdSense 客户端 ID</label>
            <input id="adsClient" v-model="ads.client" class="input font-mono text-[12px]" placeholder="ca-pub-xxxxxxxxxxxxxxxx" />
          </div>
          <div>
            <label class="label" for="adsBelow">搜索栏下方广告代码</label>
            <textarea id="adsBelow" v-model="ads.belowSearch" class="textarea font-mono text-[12px]" rows="3" placeholder="<ins …></ins>" />
            <p class="hint">只在首页搜索栏下方展示。</p>
          </div>
          <div>
            <label class="label" for="adsBetween">文章列表间隔广告代码</label>
            <textarea id="adsBetween" v-model="ads.between" class="textarea font-mono text-[12px]" rows="3" />
          </div>
          <div>
            <label class="label" for="adsEvery">每隔几篇文章插入一次</label>
            <input id="adsEvery" v-model.number="ads.betweenEvery" class="input" type="number" min="1" step="1" style="max-width: 220px" />
          </div>
          <div>
            <label class="label" for="adsContent">文章底部广告代码</label>
            <textarea id="adsContent" v-model="ads.content" class="textarea font-mono text-[12px]" rows="3" />
            <p class="hint">只在文章正文底部展示。</p>
          </div>
        </template>

        <template v-else>
          <p class="hint">高级模式：直接编辑 JSON，点“应用 JSON”前会校验格式。</p>
          <textarea v-model="adsJsonDraft" class="textarea font-mono text-[12px]" rows="10" spellcheck="false" @input="adsJsonError = ''" />
          <p v-if="adsJsonError" class="hint text-danger">{{ adsJsonError }}</p>
          <div class="flex flex-wrap gap-2">
            <button class="btn btn-sm btn-primary" type="button" @click="applyAdsJson">应用 JSON</button>
            <button class="btn btn-sm btn-ghost" type="button" @click="closeAdsJson">取消</button>
          </div>
        </template>
      </section>
    </div>

    <!-- 资料：作者资料（对应上游 profile tab） -->
    <div v-show="tab === 'profile'" data-tab-panel="profile" class="grid gap-6 xl:grid-cols-2 items-start">
      <section class="card p-5 space-y-4">
        <h2 class="text-[15px] font-semibold">作者资料</h2>
        <div><label class="label" for="profileName">作者名称</label><input id="profileName" v-model="profile.name" class="input" /></div>
        <div><label class="label" for="profileBio">个人简介</label><textarea id="profileBio" v-model="profile.bio" class="textarea" rows="3" /></div>
        <div class="flex items-start gap-3">
          <span class="grid place-items-center size-12 shrink-0 overflow-hidden rounded-full bg-surface-2 text-ink-muted text-[15px] font-semibold">
            <img
              v-if="profile.avatar && !avatarError"
              :src="profile.avatar"
              alt=""
              class="size-full object-cover"
              @error="avatarError = true"
            />
            <span v-else>{{ (profile.name || '作').slice(0, 1) }}</span>
          </span>
          <div class="min-w-0 flex-1">
            <label class="label" for="profileAvatar">头像 URL</label>
            <input id="profileAvatar" v-model="profile.avatar" class="input font-mono text-[12px]" placeholder="https://… 或 /media/…" />
            <p class="hint">粘贴图片地址后这里会即时预览。</p>
          </div>
        </div>
        <div><label class="label" for="profileEmail">通知邮箱</label><input id="profileEmail" v-model="profile.email" class="input" type="email" /></div>
      </section>
    </div>

    <!-- 顶部导航（对应上游 nav tab） -->
    <div v-show="tab === 'nav'" data-tab-panel="nav" class="grid gap-6 xl:grid-cols-2 items-start">
      <ListEditorCard
        v-model="navItems"
        title="顶部导航"
        hint="拖动左侧手柄或点 ↑↓ 调整顺序；文字留空则按语言自动翻译。「出现位置」控制该项是一级导航还是收进「发现」下拉。编辑中的改动会自动保存在本地，刷新不丢。"
        :fields="[{ key: 'text', placeholder: '显示文字（留空自动翻译）' }, { key: 'url', placeholder: '/path', mono: true }]"
        :allow-children="true"
        show-discover
        add-label="添加菜单项"
        empty-text="暂无导航项，点击下方按钮添加。"
        resettable
        @reset="resetNav"
      />
    </div>

    <!-- 页脚导航（对应上游 footerNav tab） -->
    <div v-show="tab === 'footerNav'" data-tab-panel="footerNav" class="grid gap-6 xl:grid-cols-2 items-start">
      <ListEditorCard
        v-model="footerNavItems"
        title="页脚导航"
        hint="页脚上方的一排链接，拖动排序。"
        :fields="[{ key: 'text', placeholder: '链接文字' }, { key: 'url', placeholder: '/path', mono: true }]"
        add-label="添加链接"
        empty-text="暂无页脚链接。"
      />
    </div>

    <!-- 友情链接（对应上游 friends tab） -->
    <div v-show="tab === 'friends'" data-tab-panel="friends" class="grid gap-6 xl:grid-cols-2 items-start">
      <ListEditorCard
        v-model="friendLinks"
        title="友情链接"
        hint="显示在页脚与「朋友圈」页面。"
        :fields="[{ key: 'text', placeholder: '站点名称' }, { key: 'url', placeholder: 'https://…', mono: true }]"
        add-label="添加友链"
        empty-text="暂无友情链接。"
      />
    </div>

    <div class="flex items-start gap-2 rounded-xl border border-line bg-surface-2 px-4 py-3 text-[12.5px] text-ink-muted">
      <Info :size="15" class="text-accent shrink-0 mt-0.5" />
      导航、页脚导航、友链、首页标签与广告位均为可视化编辑：拖动 ⠿ 手柄或点 ↑↓ 调整顺序，点右上角「JSON」可切换到高级 JSON 模式，保存格式与前台完全兼容。
    </div>

    <!-- 页面较长，底部再给一个保存入口 -->
    <div class="flex justify-end">
      <button class="btn btn-primary shrink-0" :disabled="saving" @click="save">
        <Loader2 v-if="saving" :size="16" class="animate-spin" />
        <Save v-else :size="16" />
        <span>{{ saving ? '保存中…' : '保存全部' }}</span>
      </button>
    </div>
  </div>
</template>