<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  Sparkles, Save, Loader2, RefreshCw, Eye, EyeOff, CircleAlert, CircleCheck, Trash2, Zap
} from '@lucide/vue';
import { api, ApiError, type AiConfigPatch, type AiConfigView } from '../lib/api';
import { t } from '../lib/i18n';
import { toast } from '../lib/toast';

/* ------------------------------------------------------------
 * 自托管版专有的 AI 配置页
 * ------------------------------------------------------------
 * 上游（Cloudflare 版）的 AI 是平台绑定 env.AI，没有「网关地址 / Key /
 * 模型」这些概念，所以这一页在原版不存在，是自托管版自己加的。
 *
 * 表单有两个容易做错的地方，这里刻意处理了：
 *
 * 1）「留空 = 沿用 .env」。输入框的 placeholder 显示 .env 里的当前值，
 *    用户只改模型名时其余字段保持空 = 不动，服务端也就不会把地址或 Key
 *    写空（早期版本「保存一个字段把其余字段清空」是典型事故）。
 *
 * 2）API Key 永不回显明文。GET 只给掩码（前 3 后 4），输入框里保持占位；
 *    只有用户真的输入了新值才提交该字段。
 * ------------------------------------------------------------ */

/** 常见模型，只是快捷入口——任何模型名都可以手动输入。 */
const PRESET_MODELS = [
  'deepseek-v4-flash',
  'deepseek-chat',
  'gpt-4o-mini',
  'gpt-4o',
  'qwen-plus',
  'glm-4-flash',
  'moonshot-v1-8k',
  'llama3.2'
];

const loading = ref(true);
const saving = ref(false);
const testing = ref(false);
const failed = ref(false);

const view = ref<AiConfigView | null>(null);
const updatedAt = ref('');

/* 表单值。空串 = 沿用 .env；-1 = 未设置（沿用 .env）。 */
const form = ref({
  base_url: '',
  model: '',
  api_key: '',
  timeout_ms: 0,
  max_retries: -1,
  enabled: -1,
  public_enabled: -1
});

const showKey = ref(false);
const keyTouched = ref(false);

/** 是否已用后台值覆盖了 .env */
const overridden = computed(() => view.value?.overridden ?? false);
const hasStoredKey = computed(() => view.value?.api_key_set ?? false);

/** 输入框占位符：显示 .env 的当前值，并提示「留空则沿用」。 */
function envHint(fallback: string | number): string {
  return `${String(fallback || t('admin.ai.notSet'))} · ${t('admin.ai.envHint')}`;
}

async function load(): Promise<void> {
  loading.value = true;
  failed.value = false;
  try {
    const data = await api.getAiConfig();
    view.value = data;
    updatedAt.value = data.updated_at ?? '';
    form.value = {
      base_url: data.stored?.base_url ?? '',
      model: data.stored?.model ?? '',
      api_key: '',
      timeout_ms: Number(data.stored?.timeout_ms ?? 0),
      max_retries: Number(data.stored?.max_retries ?? -1),
      enabled: Number(data.stored?.enabled ?? -1),
      public_enabled: Number(data.stored?.public_enabled ?? -1)
    };
    keyTouched.value = false;
    showKey.value = false;
  } catch (e) {
    view.value = null;
    failed.value = true;
    toast.error(e instanceof ApiError ? e.message : t('admin.ai.loadFail'));
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const patch: AiConfigPatch = {
      base_url: form.value.base_url,
      model: form.value.model,
      timeout_ms: form.value.timeout_ms || null,
      max_retries: form.value.max_retries >= 0 ? form.value.max_retries : null,
      enabled: form.value.enabled >= 0 ? form.value.enabled : null,
      public_enabled: form.value.public_enabled >= 0 ? form.value.public_enabled : null
    };
    // 只有用户真的改过 Key 才提交——否则会拿空串把已存的 Key 清掉
    if (keyTouched.value) patch.api_key = form.value.api_key;

    const data = await api.saveAiConfig(patch);
    view.value = data;
    updatedAt.value = data.updated_at ?? '';
    keyTouched.value = false;
    form.value.api_key = '';
    toast.success(t('admin.ai.saved'));
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t('admin.ai.saveFail'));
  } finally {
    saving.value = false;
  }
}

async function test(): Promise<void> {
  testing.value = true;
  try {
    const result = await api.testAiConfig();
    if (result.ok) {
      toast.success(`${t('admin.ai.testOk')} · ${result.ms}ms${result.reply ? ` · ${result.reply}` : ''}`);
    } else {
      toast.error(result.error || t('admin.ai.testFail'));
    }
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t('admin.ai.testFail'));
  } finally {
    testing.value = false;
  }
}

/** 清空库里的覆盖，全部回退到 .env */
async function reset(): Promise<void> {
  saving.value = true;
  try {
    const data = await api.saveAiConfig({
      base_url: '',
      api_key: '',
      model: '',
      timeout_ms: null,
      max_retries: null,
      enabled: null,
      public_enabled: null
    });
    view.value = data;
    updatedAt.value = '';
    form.value = {
      base_url: '',
      model: '',
      api_key: '',
      timeout_ms: 0,
      max_retries: -1,
      enabled: -1,
      public_enabled: -1
    };
    keyTouched.value = false;
    toast.success(t('admin.ai.resetOk'));
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t('admin.ai.saveFail'));
  } finally {
    saving.value = false;
  }
}

function toggle(flag: 'enabled' | 'public_enabled'): void {
  // 三态：未设置(-1) → 开(1) → 关(0) → 未设置
  const cur = form.value[flag];
  form.value[flag] = cur === -1 ? 1 : cur === 1 ? 0 : -1;
}

function flagLabel(v: number): string {
  if (v === 1) return t('admin.ai.on');
  if (v === 0) return t('admin.ai.off');
  return t('admin.ai.followEnv');
}

onMounted(load);
</script>

<template>
  <div>
    <!-- 工具条 -->
    <div class="flex flex-wrap items-center gap-3 mb-5">
      <p class="text-[13px] text-ink-muted">
        {{ t('admin.ai.desc') }}
        <span v-if="updatedAt" class="text-ink-muted/80">· {{ t('admin.ai.updatedAt') }} {{ updatedAt.slice(0, 19).replace('T', ' ') }}</span>
      </p>
      <div class="ml-auto flex items-center gap-2 shrink-0">
        <button class="btn btn-secondary" :disabled="loading || testing" @click="test">
          <Loader2 v-if="testing" :size="16" class="animate-spin" />
          <Zap v-else :size="16" />
          <span>{{ testing ? t('admin.ai.testing') : t('admin.ai.test') }}</span>
        </button>
        <button class="btn btn-primary" :disabled="loading || saving" @click="save">
          <Loader2 v-if="saving" :size="16" class="animate-spin" />
          <Save v-else :size="16" />
          <span>{{ saving ? t('admin.ai.saving') : t('admin.ai.save') }}</span>
        </button>
      </div>
    </div>

    <!-- 加载骨架 -->
    <div v-if="loading" class="space-y-3">
      <div v-for="i in 3" :key="i" class="card p-5 h-[150px] shimmer" />
    </div>

    <!-- 失败状态 -->
    <div v-else-if="failed" class="card py-16 flex flex-col items-center text-center">
      <span class="grid place-items-center size-12 rounded-2xl bg-surface-2 text-ink-muted mb-3">
        <CircleAlert :size="22" />
      </span>
      <p class="text-sm font-medium">{{ t('admin.ai.loadFail') }}</p>
      <button class="btn btn-primary mt-5" @click="load">
        <RefreshCw :size="16" />
        {{ t('admin.ai.retry') }}
      </button>
    </div>

    <div v-else class="space-y-4">
      <!-- 状态提示 -->
      <div class="card p-4 flex items-start gap-3">
        <CircleCheck v-if="overridden" :size="16" class="text-success mt-0.5 shrink-0" />
        <CircleAlert v-else :size="16" class="text-ink-muted mt-0.5 shrink-0" />
        <div class="text-[13px] leading-relaxed">
          <p class="font-medium">
            {{ overridden ? t('admin.ai.overridden') : t('admin.ai.followingEnv') }}
          </p>
          <p class="text-ink-muted mt-0.5">{{ t('admin.ai.followHint') }}</p>
        </div>
      </div>

      <!-- 网关 -->
      <section class="card p-5">
        <h3 class="flex items-center gap-2 text-[14px] font-semibold mb-4">
          <Sparkles :size="16" class="text-brand" />
          {{ t('admin.ai.gateway') }}
        </h3>

        <div class="grid gap-4">
          <label class="block">
            <span class="text-[12.5px] font-medium">{{ t('admin.ai.baseUrl') }}</span>
            <input
              v-model="form.base_url"
              class="input mt-1.5"
              :placeholder="envHint(view?.env?.base_url || '')"
              autocomplete="off"
            />
            <span class="text-[12px] text-ink-muted mt-1 block">{{ t('admin.ai.baseUrlHint') }}</span>
          </label>

          <label class="block">
            <span class="text-[12.5px] font-medium">{{ t('admin.ai.apiKey') }}</span>
            <div class="relative mt-1.5">
              <input
                v-model="form.api_key"
                :type="showKey ? 'text' : 'password'"
                class="input pr-10"
                :placeholder="hasStoredKey && !keyTouched ? (view?.api_key_masked || '••••••••') : t('admin.ai.apiKeyPh')"
                autocomplete="new-password"
                @input="keyTouched = true"
              />
              <button
                type="button"
                class="absolute right-2 top-1/2 -translate-y-1/2 grid place-items-center size-7 rounded-md text-ink-muted hover:text-ink hover:bg-surface-2"
                :aria-label="t('admin.ai.toggleKey')"
                @click="showKey = !showKey"
              >
                <EyeOff v-if="showKey" :size="15" />
                <Eye v-else :size="15" />
              </button>
            </div>
            <span class="text-[12px] text-ink-muted mt-1 block">
              {{ keyTouched ? t('admin.ai.apiKeyWillReplace') : t('admin.ai.apiKeyKeep') }}
            </span>
          </label>

          <label class="block">
            <span class="text-[12.5px] font-medium">{{ t('admin.ai.model') }}</span>
            <input
              v-model="form.model"
              class="input mt-1.5"
              :placeholder="envHint(view?.env?.model || '')"
              list="ai-preset-models"
              autocomplete="off"
            />
            <datalist id="ai-preset-models">
              <option v-for="m in PRESET_MODELS" :key="m" :value="m" />
            </datalist>
            <span class="text-[12px] text-ink-muted mt-1 block">{{ t('admin.ai.modelHint') }}</span>
          </label>
        </div>
      </section>

      <!-- 开关与高级 -->
      <section class="card p-5">
        <h3 class="text-[14px] font-semibold mb-4">{{ t('admin.ai.advanced') }}</h3>

        <div class="grid gap-4">
          <div class="flex items-center justify-between gap-4">
            <div>
              <p class="text-[13px] font-medium">{{ t('admin.ai.timeout') }}</p>
              <p class="text-[12px] text-ink-muted mt-0.5">{{ t('admin.ai.timeoutHint') }}</p>
            </div>
            <input
              v-model.number="form.timeout_ms"
              type="number"
              min="1000"
              step="1000"
              class="input w-32 shrink-0"
              :placeholder="String(view?.env?.timeout_ms ?? 60000)"
            />
          </div>

          <div class="flex items-center justify-between gap-4">
            <div>
              <p class="text-[13px] font-medium">{{ t('admin.ai.retries') }}</p>
              <p class="text-[12px] text-ink-muted mt-0.5">{{ t('admin.ai.retriesHint') }}</p>
            </div>
            <input
              v-model.number="form.max_retries"
              type="number"
              min="-1"
              max="5"
              class="input w-32 shrink-0"
              :placeholder="String(view?.env?.max_retries ?? 1)"
            />
          </div>

          <div class="flex items-center justify-between gap-4 pt-3 border-t border-line">
            <div>
              <p class="text-[13px] font-medium">{{ t('admin.ai.enable') }}</p>
              <p class="text-[12px] text-ink-muted mt-0.5">{{ t('admin.ai.enableHint') }}</p>
            </div>
            <button class="btn btn-secondary shrink-0" @click="toggle('enabled')">
              {{ flagLabel(form.enabled) }}
            </button>
          </div>

          <div class="flex items-center justify-between gap-4">
            <div>
              <p class="text-[13px] font-medium">{{ t('admin.ai.public') }}</p>
              <p class="text-[12px] text-ink-muted mt-0.5">{{ t('admin.ai.publicHint') }}</p>
            </div>
            <button class="btn btn-secondary shrink-0" @click="toggle('public_enabled')">
              {{ flagLabel(form.public_enabled) }}
            </button>
          </div>
        </div>
      </section>

      <!-- 危险操作 -->
      <section class="card p-5 border-warning/40">
        <h3 class="text-[14px] font-semibold mb-2">{{ t('admin.ai.resetTitle') }}</h3>
        <p class="text-[12.5px] text-ink-muted mb-4">{{ t('admin.ai.resetHint') }}</p>
        <button class="btn btn-secondary" :disabled="saving" @click="reset">
          <Trash2 :size="16" />
          {{ t('admin.ai.reset') }}
        </button>
      </section>
    </div>
  </div>
</template>
