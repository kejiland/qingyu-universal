<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  Sparkles, Save, Loader2, RefreshCw, Eye, EyeOff, CircleAlert, CircleCheck, Trash2, Zap, Download
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
 * 配置**只有数据库一个真源**：早期版本还有一层 .env 兜底（留空 = 沿用
 * .env），实际用下来弊大于利——同一项两个真源，排障要先问「哪份生效」，
 * 且 .env 改完还得重启。现在超时 / 重试未设置时用代码默认值，
 * 界面上直接把默认值写在 placeholder 里。
 *
 * 表单有两个容易做错的地方，这里刻意处理了：
 *
 * 1）未提交的字段服务端保持原样。用户只改模型名时，地址与 Key 不会被写空
 *    （早期版本「保存一个字段把其余字段清空」是典型事故）。
 *
 * 2）API Key 永不回显明文。GET 只给掩码（前 3 后 4），输入框里保持占位；
 *    只有用户真的输入了新值才提交该字段。
 * ------------------------------------------------------------ */

/** 还没从网关拉到列表时的兜底快捷项；拉到之后一律以网关返回的为准。 */
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
const fetching = ref(false);
const failed = ref(false);

const view = ref<AiConfigView | null>(null);
const updatedAt = ref('');

/** 从网关 /models 拉到的模型（为空表示还没拉过）。 */
const modelOptions = ref<Array<{ id: string; name: string }>>([]);

/* 表单值。空串 = 未设置；-1 = 未设置（用代码默认值 / 默认开启）。 */
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

/** 后台是否已在库里存过配置 */
const configured = computed(() => view.value?.configured ?? false);
/** 真正可用 = 已启用且填了网关地址 */
const usable = computed(() => view.value?.usable ?? false);
const hasStoredKey = computed(() => view.value?.api_key_set ?? false);

/** 供输入联想用的模型名：优先网关拉取结果，没拉过才用内置快捷项。 */
const modelSuggestions = computed(() =>
  modelOptions.value.length ? modelOptions.value.map((m) => m.id) : PRESET_MODELS
);

/** 未设置时实际生效的默认值（写在 placeholder 里，免得去猜）。 */
function defaultHint(value: number): string {
  return `${value} · ${t('admin.ai.defaultHint')}`;
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

/**
 * 从网关拉模型列表。
 * 用**表单里当前填的**地址 / Key（而不是只拿库里的）：典型流程是
 * 「填地址 → 填 Key → 点拉取 → 选一个 → 保存」，这时候库里还什么都没有。
 */
async function fetchModels(): Promise<void> {
  fetching.value = true;
  try {
    const override: Pick<AiConfigPatch, 'base_url' | 'api_key'> = {};
    if (form.value.base_url.trim()) override.base_url = form.value.base_url.trim();
    if (keyTouched.value && form.value.api_key) override.api_key = form.value.api_key;

    const result = await api.fetchAiModels(override);
    if (!result.ok) {
      toast.error(result.error || t('admin.ai.fetchFail'));
      return;
    }
    modelOptions.value = result.models ?? [];
    // 还没填模型名时自动落一个，省掉「拉完还要手打一遍」
    if (!form.value.model.trim() && modelOptions.value.length) {
      form.value.model = modelOptions.value[0].id;
    }
    toast.success(`${t('admin.ai.fetchOk')} · ${result.count ?? modelOptions.value.length}`);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t('admin.ai.fetchFail'));
  } finally {
    fetching.value = false;
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

/** 清空库里的 AI 配置（回到「未配置」状态） */
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
  // 三态：未设置(-1，按默认开) → 开(1) → 关(0) → 未设置
  const cur = form.value[flag];
  form.value[flag] = cur === -1 ? 1 : cur === 1 ? 0 : -1;
}

function flagLabel(v: number): string {
  if (v === 1) return t('admin.ai.on');
  if (v === 0) return t('admin.ai.off');
  return t('admin.ai.defaultFlag');
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
        <CircleCheck v-if="usable" :size="16" class="text-success mt-0.5 shrink-0" />
        <CircleAlert v-else :size="16" class="text-ink-muted mt-0.5 shrink-0" />
        <div class="text-[13px] leading-relaxed">
          <p class="font-medium">
            {{ usable ? t('admin.ai.usable') : configured ? t('admin.ai.configured') : t('admin.ai.notConfigured') }}
          </p>
          <p class="text-ink-muted mt-0.5">{{ t('admin.ai.configHint') }}</p>
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
              :placeholder="t('admin.ai.baseUrlPh')"
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
            <div class="flex items-center gap-2 mt-1.5">
              <input
                v-model="form.model"
                class="input flex-1"
                :placeholder="t('admin.ai.modelPh')"
                list="ai-model-options"
                autocomplete="off"
              />
              <button
                type="button"
                class="btn btn-secondary shrink-0"
                :disabled="fetching || !form.base_url.trim()"
                :title="t('admin.ai.fetchModelsHint')"
                @click="fetchModels"
              >
                <Loader2 v-if="fetching" :size="15" class="animate-spin" />
                <Download v-else :size="15" />
                <span class="whitespace-nowrap">{{ fetching ? t('admin.ai.fetching') : t('admin.ai.fetchModels') }}</span>
              </button>
            </div>
            <datalist id="ai-model-options">
              <option v-for="m in modelSuggestions" :key="m" :value="m" />
            </datalist>

            <!-- 拉取结果：直接点一下就能选中，不用再手打一遍 -->
            <div v-if="modelOptions.length" class="mt-2">
              <select
                class="input"
                :value="form.model"
                @change="form.model = ($event.target as HTMLSelectElement).value"
              >
                <option value="">{{ t('admin.ai.modelPick') }}（{{ modelOptions.length }}）</option>
                <option v-for="m in modelOptions" :key="m.id" :value="m.id">{{ m.id }}</option>
              </select>
            </div>

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
              :placeholder="defaultHint(view?.defaults?.timeout_ms ?? 60000)"
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
              :placeholder="defaultHint(view?.defaults?.max_retries ?? 1)"
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
        <h3 class="text-[14px] font-semibold mb-2">{{ t('admin.ai.clearTitle') }}</h3>
        <p class="text-[12.5px] text-ink-muted mb-4">{{ t('admin.ai.clearHint') }}</p>
        <button class="btn btn-secondary" :disabled="saving" @click="reset">
          <Trash2 :size="16" />
          {{ t('admin.ai.reset') }}
        </button>
      </section>
    </div>
  </div>
</template>
