<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { PenLine, Loader2, Eye, EyeOff, KeyRound, ShieldCheck, Lock } from '@lucide/vue';
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

/* ---------- 强制改密门禁 ----------
 * 触发来源：登录响应 mustChange / 服务端 403 PASSWORD_CHANGE_REQUIRED（本地标记）
 * 与 qy:password-change-required 事件。门禁期间不可跳过后台，只能改密或退出。 */
const MUST_CHANGE_KEY = 'qingyu.admin.mustChange';
const INITIAL_PWD_KEY = 'qingyu.admin.initialPwd';
const gateActive = ref(false);
const gateBusy = ref(false);
const gateError = ref('');
const gate = ref({ current: '', password: '' });

function readFlag(): boolean {
  try {
    return localStorage.getItem(MUST_CHANGE_KEY) === '1';
  } catch {
    return false;
  }
}

function setFlag(value: boolean): void {
  try {
    if (value) localStorage.setItem(MUST_CHANGE_KEY, '1');
    else localStorage.removeItem(MUST_CHANGE_KEY);
  } catch {
    /* 隐私模式下忽略 */
  }
}

function readInitialPwd(): string {
  if (defaultPassword.value) return defaultPassword.value;
  try {
    return sessionStorage.getItem(INITIAL_PWD_KEY) || '';
  } catch {
    return '';
  }
}

/** 当前会话是否被要求强制改密（本地标记优先，兼容全局钩子） */
function mustChangeRequired(): boolean {
  if (readFlag()) return true;
  const w = window as unknown as { _mustChangeRequired?: () => boolean };
  return typeof w._mustChangeRequired === 'function' && !!w._mustChangeRequired();
}

function openGate(): void {
  gateActive.value = true;
  gateError.value = '';
  if (!gate.value.current) gate.value.current = readInitialPwd();
}

function onPasswordChangeRequired(): void {
  openGate();
}

const canSubmit = computed(() => {
  if (busy.value) return false;
  if (mode.value === 'login') return password.value.length > 0;
  return password.value.length >= 8 && password.value === confirm.value;
});

const mismatch = computed(() => mode.value === 'setup' && confirm.value.length > 0 && password.value !== confirm.value);

const subtitle = computed(() => {
  if (gateActive.value) return '请先修改初始密码';
  return mode.value === 'login' ? '登录以管理你的站点' : '首次使用，设置管理员密码';
});

onMounted(() => {
  window.addEventListener('qy:password-change-required', onPasswordChangeRequired);
  if (mustChangeRequired()) openGate();
});

onBeforeUnmount(() => {
  window.removeEventListener('qy:password-change-required', onPasswordChangeRequired);
});

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

    // 服务端要求改密：进入不可跳过的改密页，不再跳转后台
    if (result.mustChange) {
      setFlag(true);
      if (result.defaultPassword) defaultPassword.value = result.defaultPassword;
      gate.value.current = readInitialPwd() || password.value;
      openGate();
      toast.info('首次登录请先修改初始密码');
      return;
    }

    if (result.defaultPassword) {
      defaultPassword.value = result.defaultPassword;
      toast.info('已自动生成初始密码，请尽快修改');
    } else {
      toast.success('登录成功');
    }

    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    await router.replace(redirect);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '请求失败，请稍后重试';
  } finally {
    busy.value = false;
  }
}

/** 门禁内提交新密码：成功后清除会话，回到登录表单用新密码登录 */
async function submitGate(): Promise<void> {
  if (gateBusy.value) return;
  const current = gate.value.current.trim();
  if (!current) {
    gateError.value = '请输入当前密码';
    return;
  }
  if (gate.value.password.length < 8) {
    gateError.value = '新密码至少 8 位';
    return;
  }
  gateBusy.value = true;
  gateError.value = '';
  try {
    const result = await api.changePassword(current, gate.value.password);
    toast.success(result.message || '密码已更新，请用新密码登录');
    setFlag(false);
    session.clear();
    gate.value = { current: '', password: '' };
    defaultPassword.value = '';
    gateActive.value = false;
    password.value = '';
    confirm.value = '';
    mode.value = 'login';
  } catch (e) {
    gateError.value = e instanceof ApiError ? e.message : '修改失败，请重试';
  } finally {
    gateBusy.value = false;
  }
}

/** 门禁内退出登录：清除会话与标记，回到普通登录表单 */
function exitGate(): void {
  setFlag(false);
  session.clear();
  gate.value = { current: '', password: '' };
  defaultPassword.value = '';
  gateActive.value = false;
  toast.info('已退出登录');
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
          <Lock v-if="gateActive" :size="24" :stroke-width="2.2" />
          <PenLine v-else :size="24" :stroke-width="2.2" />
        </span>
        <h1 class="text-[22px] font-semibold tracking-tight">轻语博客</h1>
        <p class="text-[13px] text-ink-muted mt-1">{{ subtitle }}</p>
      </div>

      <div class="card p-6">
        <!-- 强制改密门禁（不可跳过） -->
        <template v-if="gateActive">
          <h2 class="text-[15px] font-semibold mb-1">请先修改初始密码</h2>
          <p class="text-[12.5px] text-ink-muted mb-5">为保障账号安全，首次登录必须修改初始密码后才能进入后台。</p>

          <form class="space-y-4" @submit.prevent="submitGate">
            <div>
              <label class="label" for="gateCurrent">当前密码</label>
              <div class="relative">
                <KeyRound :size="16" class="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none" />
                <input
                  id="gateCurrent"
                  v-model="gate.current"
                  class="input input-lg pl-9"
                  type="password"
                  autocomplete="current-password"
                  autofocus
                />
              </div>
            </div>
            <div>
              <label class="label" for="gateNew">新密码</label>
              <input
                id="gateNew"
                v-model="gate.password"
                class="input input-lg"
                type="password"
                autocomplete="new-password"
                placeholder="至少 8 位"
              />
            </div>

            <Transition name="fade">
              <div v-if="gateError" class="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
                {{ gateError }}
              </div>
            </Transition>

            <button type="submit" class="btn btn-primary w-full h-10" :disabled="gateBusy">
              <Loader2 v-if="gateBusy" :size="16" class="animate-spin" />
              <span>{{ gateBusy ? '提交中…' : '修改密码' }}</span>
            </button>
          </form>

          <button type="button" class="btn btn-ghost w-full mt-2" @click="exitGate">退出登录</button>
        </template>

        <template v-else>
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
        </template>

        <!-- 自动生成的初始密码 -->
        <div v-if="defaultPassword" class="mt-4 rounded-lg border border-warning/30 bg-warning-soft p-3">
          <div class="flex items-center gap-1.5 text-[12px] font-medium text-warning mb-1.5">
            <ShieldCheck :size="14" /> 本次生成的初始密码
          </div>
          <code class="block font-mono text-sm text-ink break-all">{{ defaultPassword }}</code>
          <p class="hint">请尽快在「设置 → 修改密码」中更换为自定义密码。</p>
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
