<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Save, Loader2, KeyRound, ArrowRight } from '@lucide/vue';
import { api, ApiError } from '../lib/api';
import { toast } from '../lib/toast';

const loading = ref(true);
const saving = ref(false);
const changing = ref(false);

const site = ref({ name: '', desc: '', avatar: '' });
const pwd = ref({ current: '', password: '', confirm: '' });

onMounted(async () => {
  try {
    const { settings } = await api.getSettings();
    const parsed = safeParse(settings.site);
    site.value = {
      name: String(parsed.name ?? ''),
      desc: String(parsed.desc ?? ''),
      avatar: String(parsed.avatar ?? '')
    };
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '加载设置失败');
  } finally {
    loading.value = false;
  }
});

function safeParse(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function saveSite(): Promise<void> {
  saving.value = true;
  try {
    const payload = { name: site.value.name.trim(), desc: site.value.desc.trim(), avatar: site.value.avatar.trim() };
    await api.saveSettings({ site: payload, site_info: payload });
    toast.success('站点信息已保存（标题、分享卡片会立即更新）');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

async function changePassword(): Promise<void> {
  if (pwd.value.password.length < 8) {
    toast.error('新密码至少 8 位');
    return;
  }
  if (pwd.value.password !== pwd.value.confirm) {
    toast.error('两次输入的新密码不一致');
    return;
  }
  changing.value = true;
  try {
    const result = await api.changePassword(pwd.value.current, pwd.value.password);
    toast.success(result.message || '密码已更新，请重新登录');
    pwd.value = { current: '', password: '', confirm: '' };
    window.setTimeout(() => {
      window.location.href = '/admin/login';
    }, 1200);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '修改失败');
  } finally {
    changing.value = false;
  }
}
</script>

<template>
  <div v-if="loading" class="card h-64 shimmer" />

  <div v-else class="grid gap-6 max-w-3xl items-start">
    <div class="space-y-6">
      <!-- 站点信息 -->
      <section class="card p-5">
        <h2 class="text-[15px] font-semibold mb-1">站点信息</h2>
        <p class="text-[12.5px] text-ink-muted mb-5">
          影响浏览器标题、社交分享卡片、JSON-LD 与页脚署名。
        </p>

        <div class="space-y-4 max-w-lg">
          <div>
            <label class="label" for="siteName">站点名称</label>
            <input id="siteName" v-model="site.name" class="input" placeholder="我的博客" />
          </div>
          <div>
            <label class="label" for="siteDesc">站点简介</label>
            <textarea id="siteDesc" v-model="site.desc" class="textarea" rows="3" placeholder="一句话说明这个站点" />
            <p class="hint">用于首页 meta description 与分享卡片；留空会回退到内置默认值。</p>
          </div>
          <div>
            <label class="label" for="siteAvatar">站点头像 / Logo URL</label>
            <input id="siteAvatar" v-model="site.avatar" class="input font-mono text-[13px]" placeholder="https://… 或 /media/…" />
          </div>
          <button class="btn btn-primary" :disabled="saving" @click="saveSite">
            <Loader2 v-if="saving" :size="16" class="animate-spin" />
            <Save v-else :size="16" />
            <span>{{ saving ? '保存中…' : '保存' }}</span>
          </button>
        </div>
      </section>

      <!-- 修改密码 -->
      <section class="card p-5">
        <h2 class="text-[15px] font-semibold mb-1">修改密码</h2>
        <p class="text-[12.5px] text-ink-muted mb-5">修改后当前会话会失效，需要重新登录。</p>

        <div class="space-y-4 max-w-lg">
          <div>
            <label class="label" for="curPwd">当前密码</label>
            <input id="curPwd" v-model="pwd.current" type="password" class="input" autocomplete="current-password" />
          </div>
          <div class="grid sm:grid-cols-2 gap-4">
            <div>
              <label class="label" for="newPwd">新密码</label>
              <input id="newPwd" v-model="pwd.password" type="password" class="input" autocomplete="new-password" placeholder="至少 8 位" />
            </div>
            <div>
              <label class="label" for="confirmPwd">确认新密码</label>
              <input id="confirmPwd" v-model="pwd.confirm" type="password" class="input" autocomplete="new-password" />
            </div>
          </div>
          <button class="btn btn-secondary" :disabled="changing" @click="changePassword">
            <Loader2 v-if="changing" :size="16" class="animate-spin" />
            <KeyRound v-else :size="16" />
            <span>更新密码</span>
          </button>
        </div>
      </section>
    </div>

    <!-- 高级设置入口 -->
    <aside class="card p-5">
      <h2 class="text-[15px] font-semibold mb-1">高级设置</h2>
      <p class="text-[12.5px] text-ink-muted leading-relaxed mb-4">
        导航菜单、页脚、公告、作者资料、功能开关、评论规则、友链与广告位已迁移到新版。
      </p>
      <RouterLink to="/settings/advanced" class="btn btn-primary w-full">
        <span>打开高级设置</span>
        <ArrowRight :size="15" />
      </RouterLink>
    </aside>
  </div>
</template>