<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  Save, Loader2, ArrowLeft, Eye, Pencil, Columns2, ImagePlus, ExternalLink, Trash2, CalendarClock
} from '@lucide/vue';
import { api, uploadTo, ApiError, type Seo } from '../lib/api';
import { debounce, slugify } from '../lib/format';
import { toast } from '../lib/toast';

const route = useRoute();
const router = useRouter();

const isNew = computed(() => route.name === 'post-new');
const id = computed(() => String(route.params.id ?? ''));

const loading = ref(!isNew.value);
const saving = ref(false);
const uploading = ref(false);
const mode = ref<'write' | 'split' | 'preview'>('split');
const fileInput = ref<HTMLInputElement | null>(null);

const form = ref({
  id: '',
  title: '',
  excerpt: '',
  content: '',
  cover: '',
  tags: '',
  category: '',
  series: '',
  author: '',
  status: 'draft' as 'published' | 'draft' | 'scheduled',
  publishAt: '' as string,
  pinned: false,
  seo: { title: '', desc: '', canonical: '', noindex: false } as Seo
});

/* ---------- 预览：marked 渲染 + DOMPurify 消毒 ---------- */
const rendered = ref('');
const renderPreview = debounce((markdown: string) => {
  const html = marked.parse(markdown || '', { async: false }) as string;
  rendered.value = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}, 180);

watch(() => form.value.content, (value) => renderPreview(value), { immediate: true });

/* ---------- 载入 ---------- */
onMounted(async () => {
  if (isNew.value) {
    form.value.status = 'draft';
    return;
  }
  try {
    const { post } = await api.getPost(id.value);
    form.value = {
      id: post.id,
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      cover: post.cover || post.ogImage || '',
      tags: (post.tags ?? []).join(', '),
      category: post.category ?? '',
      series: post.series ?? '',
      author: post.author ?? '',
      status: (post.status ?? 'draft') as typeof form.value.status,
      publishAt: post.publishAt ? new Date(post.publishAt).toISOString().slice(0, 16) : '',
      pinned: post.pinned,
      seo: { title: '', desc: '', canonical: '', noindex: false, ...(post.seo ?? {}) }
    };
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '加载文章失败');
    void router.replace({ name: 'posts' });
  } finally {
    loading.value = false;
  }
});

/* 新建时用标题自动生成 id（用户改过就不再覆盖） */
const idTouched = ref(false);
watch(
  () => form.value.title,
  (title) => {
    if (!isNew.value || idTouched.value) return;
    form.value.id = slugify(title);
  }
);

/* ---------- 保存 ---------- */
const payload = computed(() => ({
  title: form.value.title.trim(),
  excerpt: form.value.excerpt.trim(),
  content: form.value.content,
  cover: form.value.cover.trim(),
  tags: form.value.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
  category: form.value.category.trim(),
  series: form.value.series.trim(),
  author: form.value.author.trim(),
  status: form.value.status,
  pinned: form.value.pinned,
  seo: form.value.seo,
  ...(form.value.status === 'scheduled' && form.value.publishAt
    ? { publishAt: new Date(form.value.publishAt).getTime() }
    : {}),
  // 新建时若正文为空，给个占位避免出现空内容文章
  ...(isNew.value ? { date: new Date().toISOString() } : {})
}));

async function save(nextStatus?: typeof form.value.status): Promise<void> {
  if (nextStatus) form.value.status = nextStatus;
  if (!payload.value.title) {
    toast.error('请填写标题');
    return;
  }
  if (isNew.value && !form.value.id.trim()) {
    toast.error('请填写文章 ID（URL 别名）');
    return;
  }

  saving.value = true;
  try {
    if (isNew.value) {
      await api.createPost({ ...payload.value, id: form.value.id.trim() });
      toast.success('已创建');
      await router.replace({ name: 'post-edit', params: { id: form.value.id.trim() } });
    } else {
      await api.updatePost(id.value, payload.value);
      toast.success('已保存');
    }
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

/* ---------- 封面：走媒体库的直传流程 ---------- */
async function uploadCover(file: File): Promise<void> {
  uploading.value = true;
  try {
    const ticket = await api.uploadTicket(file.name, file.size, false);
    await uploadTo(ticket.uploadUrl, file, ticket.contentType || file.type);
    form.value.cover = ticket.publicUrl;
    await api
      .registerMedia({
        id: ticket.key,
        name: file.name,
        url: ticket.publicUrl,
        type: ticket.contentType || file.type,
        size: file.size
      })
      .catch(() => undefined);
    toast.success('封面上传成功');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '上传失败');
  } finally {
    uploading.value = false;
    if (fileInput.value) fileInput.value.value = '';
  }
}

async function remove(): Promise<void> {
  if (!window.confirm('确定删除这篇文章？')) return;
  try {
    await api.deletePost(id.value);
    toast.success('已删除');
    void router.replace({ name: 'posts' });
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '删除失败');
  }
}
</script>

<template>
  <div v-if="loading" class="grid place-items-center py-24 text-ink-muted">
    <Loader2 :size="22" class="animate-spin" />
  </div>

  <div v-else class="pb-20">
    <!-- 顶部操作条 -->
    <div class="sticky top-16 z-10 -mx-4 lg:-mx-8 px-4 lg:px-8 py-3 mb-5
                border-b border-line bg-canvas/85 backdrop-blur-md flex items-center gap-2 flex-wrap">
      <button class="btn btn-ghost btn-sm" @click="router.push({ name: 'posts' })">
        <ArrowLeft :size="16" />
        返回
      </button>

      <span class="text-[13px] text-ink-muted hidden sm:inline">
        {{ isNew ? '新文章' : `ID：${id}` }}
      </span>

      <div class="ml-auto flex items-center gap-2">
        <a
          v-if="!isNew && form.status === 'published'"
          class="btn btn-ghost btn-sm"
          :href="`/posts/${encodeURIComponent(id)}/`"
          target="_blank"
          rel="noopener"
        >
          <ExternalLink :size="15" />
          <span class="hidden sm:inline">查看</span>
        </a>

        <button v-if="!isNew" class="btn btn-ghost btn-sm hover:text-danger" @click="remove">
          <Trash2 :size="15" />
        </button>

        <button class="btn btn-secondary btn-sm" :disabled="saving" @click="save('draft')">
          <span>存为草稿</span>
        </button>

        <button class="btn btn-primary btn-sm" :disabled="saving" @click="save('published')">
          <Loader2 v-if="saving" :size="15" class="animate-spin" />
          <Save v-else :size="15" />
          <span>{{ saving ? '保存中…' : '发布' }}</span>
        </button>
      </div>
    </div>

    <div class="grid gap-6 lg:grid-cols-[1fr_320px] items-start">
      <!-- 主区 -->
      <div class="space-y-4 min-w-0">
        <input
          v-model="form.title"
          class="input input-lg !text-[19px] !font-semibold !h-auto !py-3"
          placeholder="文章标题"
        />

        <div class="card overflow-hidden">
          <!-- 编辑器工具条 -->
          <div class="flex items-center gap-1 px-2 py-1.5 border-b border-line bg-surface-2">
            <button
              v-for="tab in ([
                ['write', '编辑', Pencil],
                ['split', '分栏', Columns2],
                ['preview', '预览', Eye]
              ] as const)"
              :key="tab[0]"
              class="btn btn-sm"
              :class="mode === tab[0] ? 'btn-secondary' : 'btn-ghost'"
              @click="mode = tab[0]"
            >
              <component :is="tab[2]" :size="14" />
              <span class="hidden sm:inline">{{ tab[1] }}</span>
            </button>
            <span class="ml-auto text-[12px] text-ink-muted px-2 tabular-nums">
              {{ form.content.length }} 字
            </span>
          </div>

          <div class="grid" :class="mode === 'split' ? 'md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-line' : ''">
            <textarea
              v-if="mode !== 'preview'"
              v-model="form.content"
              class="w-full min-h-[540px] p-4 bg-transparent border-0 resize-none outline-none
                     font-mono text-[13.5px] leading-[1.75] focus:ring-0"
              placeholder="用 Markdown 写正文…&#10;&#10;# 一级标题&#10;&#10;**加粗**、`代码`、[链接](https://example.com)"
              spellcheck="false"
            />
            <div
              v-if="mode !== 'write'"
              class="min-h-[540px] p-5 overflow-x-auto"
            >
              <div v-if="!form.content" class="text-[13px] text-ink-muted">预览会显示在这里</div>
              <div v-else class="prose-qingyu" v-html="rendered" />
            </div>
          </div>
        </div>
      </div>

      <!-- 侧栏 -->
      <aside class="space-y-4 lg:sticky lg:top-32">
        <!-- 发布 -->
        <section class="card p-4 space-y-3.5">
          <h2 class="text-[13px] font-semibold text-ink-soft">发布</h2>

          <div>
            <label class="label">状态</label>
            <select v-model="form.status" class="select">
              <option value="draft">草稿</option>
              <option value="published">已发布</option>
              <option value="scheduled">定时发布</option>
            </select>
          </div>

          <div v-if="form.status === 'scheduled'">
            <label class="label">
              <CalendarClock :size="13" class="inline -mt-0.5 mr-1" />发布时间
            </label>
            <input v-model="form.publishAt" type="datetime-local" class="input" />
            <p class="hint">按站点时区（默认 UTC）到点自动发布。</p>
          </div>

          <label class="flex items-center gap-2 text-[13px] cursor-pointer select-none">
            <input v-model="form.pinned" type="checkbox" class="accent-[var(--accent)] size-4" />
            置顶显示
          </label>

          <div v-if="isNew">
            <label class="label" for="postId">文章 ID（URL 别名）</label>
            <input
              id="postId"
              v-model="form.id"
              class="input font-mono text-[13px]"
              placeholder="hello-world"
              @input="idTouched = true"
            />
            <p class="hint">文章地址为 /posts/&lt;ID&gt;/，发布后不建议修改。</p>
          </div>
        </section>

        <!-- 封面 -->
        <section class="card p-4 space-y-3">
          <h2 class="text-[13px] font-semibold text-ink-soft">封面</h2>
          <div
            v-if="form.cover"
            class="relative rounded-xl overflow-hidden border border-line aspect-[16/9] bg-surface-2 group"
          >
            <img :src="form.cover" alt="" class="size-full object-cover" />
            <button
              class="absolute top-2 right-2 btn btn-sm bg-black/55 text-white backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity"
              @click="form.cover = ''"
            >
              移除
            </button>
          </div>
          <label class="block">
            <input v-model="form.cover" class="input text-[13px]" placeholder="图片地址 /media/…" />
          </label>
          <input
            ref="fileInput"
            type="file"
            accept="image/*"
            class="hidden"
            @change="(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) uploadCover(f) }"
          />
          <button class="btn btn-secondary w-full btn-sm" :disabled="uploading" @click="fileInput?.click()">
            <Loader2 v-if="uploading" :size="15" class="animate-spin" />
            <ImagePlus v-else :size="15" />
            <span>{{ uploading ? '上传中…' : '上传图片' }}</span>
          </button>
        </section>

        <!-- 属性 -->
        <section class="card p-4 space-y-3.5">
          <h2 class="text-[13px] font-semibold text-ink-soft">属性</h2>

          <div>
            <label class="label">摘要</label>
            <textarea v-model="form.excerpt" class="textarea" rows="3" placeholder="列表页与分享卡片使用" />
          </div>

          <div>
            <label class="label">标签</label>
            <input v-model="form.tags" class="input" placeholder="用逗号分隔" />
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="label">分类</label>
              <input v-model="form.category" class="input" />
            </div>
            <div>
              <label class="label">作者</label>
              <input v-model="form.author" class="input" />
            </div>
          </div>

          <div>
            <label class="label">系列</label>
            <input v-model="form.series" class="input" placeholder="可选，用于系列文章" />
          </div>
        </section>

        <!-- SEO -->
        <section class="card p-4 space-y-3.5">
          <h2 class="text-[13px] font-semibold text-ink-soft">SEO 覆盖</h2>
          <p class="text-[12px] text-ink-muted -mt-1">留空则自动生成标题、描述与 canonical。</p>

          <div>
            <label class="label">SEO 标题</label>
            <input v-model="form.seo.title" class="input" placeholder="默认：标题 · 站点名" />
          </div>
          <div>
            <label class="label">SEO 描述</label>
            <textarea v-model="form.seo.desc" class="textarea" rows="2" placeholder="默认：摘要或正文前 200 字" />
          </div>
          <div>
            <label class="label">Canonical</label>
            <input v-model="form.seo.canonical" class="input font-mono text-[12px]" placeholder="https://…" />
          </div>
          <label class="flex items-center gap-2 text-[13px] cursor-pointer select-none">
            <input v-model="form.seo.noindex" type="checkbox" class="accent-[var(--accent)] size-4" />
            不被搜索引擎索引
          </label>
        </section>
      </aside>
    </div>
  </div>
</template>