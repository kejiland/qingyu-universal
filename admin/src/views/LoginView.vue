<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { PenLine, Loader2, Eye, EyeOff, KeyRound, ShieldCheck } from '@lucide/vue';
import { api, session, ApiError } from '../lib/api';
import { toast } from '../lib/toast';

const router = useRouter();
const route = useRoute();

type Mode = 'login' | 'setup';
const mode = ref<Mode>('login');

const password = ref('');
const confirm = ref('');
const setupKey = ref('');
const showPassword = ref(false);
const busy = ref(false);
const error = ref('');
const defaultPassword = ref('');

const canSubmit = computed(() => {
  if (busy.value) return false;
  if (mode.value === 'login') return password.value.length > 0;
  return password.value.length >= 8 && password.value === confirm.value;
});

const mismatch = computed(() => mode.value === 'setup' && confirm.value.length > 0 && password.value !== confirm.value);

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  busy.value = true;
  error.value = '';
  try {
    if (mode.value === 'setup') {
      await api.setup(password.value, setupKey.value);
      toast.success('管理员密码已设置，请登录');
      mode.value = 'login';
      confirm.value = '';
      password.value = '';
      return;
    }

    const result = await api.login(password.value);
    session.set(result.token);

    if (result.defaultPassword) {
      defaultPassword.value = result.defaultPassword;
      toast.info('已自动生成初始密码，请尽快修改');
    } else {
      toast.success('登录成功');
    }

    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/posts';
    await router.replace(redirect);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '请求失败，请稍后重试';
  } finally {
    busy.value = false;
  }
}

function switchMode(next: Mode): void {
  mode.value = next;
  error.value = '';
  password.value = '';
  confirm.value = '';
}
</script>

<template>
  <div class="min-h-full grid place-items-center px-5 py-10 relative overflow-hidden">
    <!-- 背景装饰：两团柔和的主色光晕 -->
    <div class="pointer-events-none absolute inset-0 -z-10">
      <div class="absolute -top-40 -left-32 size-[520px] rounded-full bg-accent/10 blur-[120px]" />
      <div class="absolute -bottom-48 -right-24 size-[460px] rounded-full bg-accent/8 blur-[120px]" />
    </div>

    <div class="w-full max-w-[400px] animate-in">
      <!-- 品牌 -->
      <div class="flex flex-col items-center mb-7">
        <span class="grid place-items-center size-12 rounded-2xl bg-accent text-white shadow-md mb-4">
          <PenLine :size="24" :stroke-width="2.2" />
        </span>
        <h1 class="text-[22px] font-semibold tracking-tight">轻语博客</h1>
        <p class="text-[13px] text-ink-muted mt-1">{{ mode === 'login' ? '登录以管理你的站点' : '首次使用，设置管理员密码' }}</p>
      </div>

      <div class="card p-6">
        <!-- 模式切换 -->
        <div class="flex gap-1 p-1 rounded-xl bg-surface-2 mb-5">
          <button
            v-for="tab in ([['login', '登录'], ['setup', '首次初始化']] as const)"
            :key="tab[0]"
            class="flex-1 h-8 rounded-[9px] text-[13px] font-medium transition-all"
            :class="mode === tab[0] ? 'bg-surface text-ink shadow-xs' : 'text-ink-muted hover:text-ink'"
            @click="switchMode(tab[0])"
          >
            {{ tab[1] }}
          </button>
        </div>

        <form class="space-y-4" @submit.prevent="submit">
          <div v-if="mode === 'setup'">
            <label class="label" for="setupKey">安装密钥</label>
            <div class="relative">
              <KeyRound :size="16" class="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none" />
              <input
                id="setupKey"
                v-model="setupKey"
                class="input input-lg pl-9 font-mono"
                type="text"
                autocomplete="off"
                placeholder=".env 里的 BLOG_ADMIN_SETUP_KEY"
              />
            </div>
            <p class="hint">在服务器 <code>.env</code> 中的 <code>BLOG_ADMIN_SETUP_KEY</code></p>
          </div>

          <div>
            <label class="label" for="password">{{ mode === 'setup' ? '设置密码' : '密码' }}</label>
            <div class="relative">
              <input
                id="password"
                v-model="password"
                class="input input-lg pr-10"
                :type="showPassword ? 'text' : 'password'"
                :autocomplete="mode === 'setup' ? 'new-password' : 'current-password'"
                placeholder="至少 8 位"
                autofocus
              />
              <button
                type="button"
                class="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink"
                :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                @click="showPassword = !showPassword"
              >
                <EyeOff v-if="showPassword" :size="17" />
                <Eye v-else :size="17" />
              </button>
            </div>
          </div>

          <div v-if="mode === 'setup'">
            <label class="label" for="confirm">确认密码</label>
            <input id="confirm" v-model="confirm" class="input input-lg" type="password" autocomplete="new-password" />
            <p v-if="mismatch" class="hint text-danger">两次输入的密码不一致</p>
          </div>

          <!-- 错误提示 -->
          <Transition name="fade">
            <div v-if="error" class="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
              {{ error }}
            </div>
          </Transition>

          <button type="submit" class="btn btn-primary w-full h-10" :disabled="!canSubmit">
            <Loader2 v-if="busy" :size="16" class="animate-spin" />
            <span>{{ mode === 'login' ? '登录' : '设置密码' }}</span>
          </button>
        </form>

        <!-- 自动生成的初始密码 -->
        <div v-if="defaultPassword" class="mt-4 rounded-lg border border-warning/30 bg-warning-soft p-3">
          <div class="flex items-center gap-1.5 text-[12px] font-medium text-warning mb-1.5">
            <ShieldCheck :size="14" /> 本次生成的初始密码
          </div>
          <code class="block font-mono text-sm text-ink break-all">{{ defaultPassword }}</code>
          <p class="hint">请立即在「设置 → 修改密码」中更换。</p>
        </div>
      </div>

      <p class="text-center text-[12px] text-ink-muted mt-5">
        <a href="/" class="hover:text-ink transition-colors">← 返回站点</a>
      </p>
    </div>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>