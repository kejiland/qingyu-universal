/* 轻量提示（toast）：不引入状态库，用一个响应式数组 + 全局函数即可。 */
import { ref } from 'vue';

export interface Toast {
  id: number;
  type: 'success' | 'error' | 'info';
  message: string;
}

export const toasts = ref<Toast[]>([]);
let seq = 0;

function push(type: Toast['type'], message: string, duration = 3200): void {
  const id = ++seq;
  toasts.value.push({ id, type, message });
  window.setTimeout(() => {
    toasts.value = toasts.value.filter((item) => item.id !== id);
  }, duration);
}

export const toast = {
  success: (message: string) => push('success', message),
  error: (message: string) => push('error', message, 5000),
  info: (message: string) => push('info', message)
};

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((item) => item.id !== id);
}