<script setup lang="ts">
import { computed, ref } from 'vue';
import { Braces, ChevronDown, ChevronUp, CornerDownRight, GripVertical, Plus, RefreshCw, Trash } from '@lucide/vue';

/** 列表字段定义：key 对应数据里的字段名，placeholder 是输入框占位提示 */
interface ListField {
  key: string;
  placeholder?: string;
  mono?: boolean;
}

const props = withDefaults(
  defineProps<{
    title: string;
    hint?: string;
    modelValue: Record<string, unknown>[];
    fields?: ListField[];
    allowChildren?: boolean;
    addLabel?: string;
    emptyText?: string;
    jsonHint?: string;
    resettable?: boolean;
    createItem?: () => Record<string, unknown>;
  }>(),
  {
    hint: '',
    fields: () => [
      { key: 'text', placeholder: '显示文字' },
      { key: 'url', placeholder: '/path' }
    ],
    allowChildren: false,
    addLabel: '添加一项',
    emptyText: '暂无内容，点击下方按钮添加。',
    jsonHint: '高级模式：直接编辑 JSON，点“应用 JSON”前会校验格式。',
    resettable: false,
    createItem: () => ({ text: '', url: '/' })
  }
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: Record<string, unknown>[]): void;
  (e: 'reset'): void;
}>();

function asList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
}

/** 每行渲染用：当前项 + 它的一级子菜单（仅导航启用） */
const rows = computed(() =>
  props.modelValue.map((item) => ({ item, children: asList(item.children) }))
);

function commit(next: Record<string, unknown>[]): void {
  emit('update:modelValue', next);
}

function setField(index: number, key: string, event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  const next = props.modelValue.map((item, i) => (i === index ? { ...item, [key]: value } : item));
  commit(next);
}

function setChildField(index: number, childIndex: number, key: string, event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  const next = props.modelValue.map((item, i) => {
    if (i !== index) return item;
    const children = asList(item.children).map((child, ci) =>
      ci === childIndex ? { ...child, [key]: value } : child
    );
    return { ...item, children };
  });
  commit(next);
}

function move(index: number, delta: number): void {
  const target = index + delta;
  if (target < 0 || target >= props.modelValue.length) return;
  const next = [...props.modelValue];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  commit(next);
}

function remove(index: number): void {
  const next = [...props.modelValue];
  next.splice(index, 1);
  commit(next);
}

function add(): void {
  commit([...props.modelValue, props.createItem()]);
}

function addChild(index: number): void {
  const next = props.modelValue.map((item, i) =>
    i === index ? { ...item, children: [...asList(item.children), { text: '', url: '/' }] } : item
  );
  commit(next);
}

function removeChild(index: number, childIndex: number): void {
  const next = props.modelValue.map((item, i) => {
    if (i !== index) return item;
    const children = [...asList(item.children)];
    children.splice(childIndex, 1);
    return { ...item, children };
  });
  commit(next);
}

/** HTML5 原生拖拽排序；同时保留 ↑↓ 按钮，触屏也能用 */
const dragIndex = ref<number | null>(null);

function onDragStart(index: number): void {
  dragIndex.value = index;
}

function onDragOver(event: DragEvent): void {
  event.preventDefault();
}

function onDrop(index: number): void {
  const from = dragIndex.value;
  dragIndex.value = null;
  if (from === null || from === index || from < 0 || from >= props.modelValue.length) return;
  const next = [...props.modelValue];
  const [item] = next.splice(from, 1);
  next.splice(index, 0, item);
  commit(next);
}

function onDragEnd(): void {
  dragIndex.value = null;
}

/** 高级用户仍可切换到 JSON 直接编辑 */
const jsonMode = ref(false);
const jsonDraft = ref('');
const jsonError = ref('');

function openJson(): void {
  jsonDraft.value = JSON.stringify(props.modelValue, null, 2);
  jsonError.value = '';
  jsonMode.value = true;
}

function closeJson(): void {
  jsonMode.value = false;
  jsonError.value = '';
}

function applyJson(): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonDraft.value || '[]');
  } catch {
    jsonError.value = '不是合法 JSON，请检查逗号、引号和括号。';
    return;
  }
  if (!Array.isArray(parsed)) {
    jsonError.value = '必须是 JSON 数组（最外层用 [] 包裹）。';
    return;
  }
  const items = parsed.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
  if (items.length !== parsed.length) {
    jsonError.value = '数组里的每一项都必须是对象（用 {} 包裹）。';
    return;
  }
  commit(items);
  closeJson();
}
</script>

<template>
  <section class="card p-5 space-y-4">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h2 class="text-[15px] font-semibold">{{ title }}</h2>
        <p v-if="hint" class="hint mt-1">{{ hint }}</p>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <button v-if="resettable" class="btn btn-sm btn-ghost" type="button" @click="emit('reset')">
          <RefreshCw :size="14" />
          <span>恢复默认</span>
        </button>
        <button class="btn btn-sm btn-ghost" type="button" :title="jsonMode ? '返回可视化编辑' : '查看 JSON'" @click="jsonMode ? closeJson() : openJson()">
          <Braces :size="14" />
          <span>{{ jsonMode ? '可视化' : 'JSON' }}</span>
        </button>
      </div>
    </div>

    <template v-if="!jsonMode">
      <p v-if="!rows.length" class="hint">{{ emptyText }}</p>

      <div v-else class="space-y-2">
        <div v-for="(row, index) in rows" :key="index">
          <div
            class="flex items-start gap-2 rounded-xl border border-line bg-surface-2 p-2 transition-opacity"
            :class="{ 'opacity-50': dragIndex === index }"
            @dragover="onDragOver"
            @drop="onDrop(index)"
          >
            <GripVertical
              :size="15"
              class="mt-2 shrink-0 cursor-grab text-ink-muted"
              draggable="true"
              title="按住拖动排序"
              aria-hidden="true"
              @dragstart="onDragStart(index)"
              @dragend="onDragEnd"
            />
            <div class="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
              <input
                v-for="field in fields"
                :key="field.key"
                class="input"
                :class="field.mono ? 'font-mono text-[12px]' : ''"
                :value="String(row.item[field.key] ?? '')"
                :placeholder="field.placeholder || ''"
                @input="setField(index, field.key, $event)"
              />
            </div>
            <div class="flex shrink-0 flex-wrap items-center justify-end gap-0.5">
              <button class="btn btn-sm btn-ghost btn-icon" type="button" title="上移" :disabled="index === 0" @click="move(index, -1)">
                <ChevronUp :size="14" />
              </button>
              <button
                class="btn btn-sm btn-ghost btn-icon"
                type="button"
                title="下移"
                :disabled="index === rows.length - 1"
                @click="move(index, 1)"
              >
                <ChevronDown :size="14" />
              </button>
              <button v-if="allowChildren" class="btn btn-sm btn-ghost btn-icon" type="button" title="添加子菜单" @click="addChild(index)">
                <Plus :size="14" />
              </button>
              <button class="btn btn-sm btn-ghost btn-icon hover:text-danger" type="button" title="删除" @click="remove(index)">
                <Trash :size="14" />
              </button>
            </div>
          </div>

          <div v-if="allowChildren && row.children.length" class="ml-6 mt-2 space-y-2 border-l border-line pl-3">
            <div
              v-for="(child, childIndex) in row.children"
              :key="childIndex"
              class="flex items-start gap-2 rounded-xl border border-line bg-surface p-2"
            >
              <CornerDownRight :size="14" class="mt-2 shrink-0 text-ink-muted" aria-hidden="true" />
              <div class="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
                <input
                  v-for="field in fields"
                  :key="field.key"
                  class="input"
                  :class="field.mono ? 'font-mono text-[12px]' : ''"
                  :value="String(child[field.key] ?? '')"
                  :placeholder="field.placeholder || ''"
                  @input="setChildField(index, childIndex, field.key, $event)"
                />
              </div>
              <button
                class="btn btn-sm btn-ghost btn-icon hover:text-danger shrink-0"
                type="button"
                title="删除子菜单"
                @click="removeChild(index, childIndex)"
              >
                <Trash :size="14" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <button class="btn btn-sm btn-secondary" type="button" @click="add">
        <Plus :size="14" />
        <span>{{ addLabel }}</span>
      </button>
    </template>

    <template v-else>
      <p class="hint">{{ jsonHint }}</p>
      <textarea
        v-model="jsonDraft"
        class="textarea font-mono text-[12px]"
        rows="10"
        spellcheck="false"
        @input="jsonError = ''"
      />
      <p v-if="jsonError" class="hint text-danger">{{ jsonError }}</p>
      <div class="flex flex-wrap gap-2">
        <button class="btn btn-sm btn-primary" type="button" @click="applyJson">应用 JSON</button>
        <button class="btn btn-sm btn-ghost" type="button" @click="closeJson">取消</button>
      </div>
    </template>
  </section>
</template>