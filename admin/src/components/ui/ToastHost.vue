<script setup lang="ts">
import { CheckCircle2, AlertCircle, Info, X } from '@lucide/vue';
import { toasts, dismissToast } from '../../lib/toast';

const styles: Record<string, { cls: string; icon: unknown }> = {
  success: { cls: 'border-success/30 bg-success-soft text-success', icon: CheckCircle2 },
  error: { cls: 'border-danger/30 bg-danger-soft text-danger', icon: AlertCircle },
  info: { cls: 'border-line bg-surface text-ink', icon: Info }
};
</script>

<template>
  <div class="fixed bottom-5 right-5 z-50 flex flex-col gap-2 w-[min(360px,calc(100vw-2.5rem))]">
    <TransitionGroup name="toast">
      <div
        v-for="item in toasts"
        :key="item.id"
        class="flex items-start gap-2.5 rounded-xl border px-3.5 py-3 shadow-lg backdrop-blur-sm"
        :class="styles[item.type]?.cls"
      >
        <component :is="styles[item.type]?.icon" :size="17" class="mt-px shrink-0" />
        <p class="flex-1 text-[13px] leading-relaxed break-words">{{ item.message }}</p>
        <button class="shrink-0 opacity-60 hover:opacity-100" aria-label="关闭" @click="dismissToast(item.id)">
          <X :size="15" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(12px) scale(0.98);
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(12px);
}
</style>