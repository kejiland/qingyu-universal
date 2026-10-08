<script setup lang="ts">
/* ============================================================
 * 可折叠分区卡片
 * ------------------------------------------------------------
 * 写文章页右侧一度把「状态 / 封面 / 分享图 / SEO」二十多个字段平铺
 * 展开，低频项（分享图、SEO）与高频项挤在一起，视觉负担很重。
 * 这个组件把低频项收进可折叠的卡片里，字段一个不少，但默认只露出
 * 常用的那部分。
 *
 * 两个刻意的选择：
 *  - 用 v-show 而不是 v-if：折叠只是隐藏，内部输入值不会被销毁，
 *    展开回来刚填的内容还在（和高级设置 tab 切换同一个道理）。
 *  - 展开状态记在 localStorage（给了 storageKey 才记）：
 *    SEO 填过一次的人下次进来还是展开的，不用每次重新点开。
 * ============================================================ */
import { ref } from 'vue';
import { ChevronDown } from '@lucide/vue';

const props = withDefaults(
  defineProps<{
    title: string;
    /** 默认是否展开；低频项传 false */
    defaultOpen?: boolean;
    /** 传了就把展开状态记进 localStorage，下次保持 */
    storageKey?: string;
  }>(),
  { defaultOpen: true, storageKey: '' }
);

const STORE_PREFIX = 'qingyu.editor.section.';

function initialOpen(): boolean {
  if (!props.storageKey) return props.defaultOpen;
  try {
    const saved = localStorage.getItem(STORE_PREFIX + props.storageKey);
    return saved === null ? props.defaultOpen : saved === '1';
  } catch {
    return props.defaultOpen;
  }
}

const open = ref(initialOpen());

function toggle(): void {
  open.value = !open.value;
  if (!props.storageKey) return;
  try {
    localStorage.setItem(STORE_PREFIX + props.storageKey, open.value ? '1' : '0');
  } catch {
    /* 隐私模式下 localStorage 不可写，忽略即可 */
  }
}
</script>

<template>
  <section class="card overflow-hidden">
    <button
      type="button"
      class="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-surface-2"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="text-[13px] font-semibold text-ink-soft">{{ title }}</span>
      <slot name="badge" />
      <ChevronDown
        :size="15"
        class="ml-auto shrink-0 text-ink-muted transition-transform duration-150"
        :class="open ? '' : '-rotate-90'"
      />
    </button>
    <div v-show="open" class="space-y-3 border-t border-line px-4 py-3.5">
      <slot />
    </div>
  </section>
</template>
