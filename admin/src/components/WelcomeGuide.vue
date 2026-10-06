<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Check, Rocket, Settings, FileText, Image, Bell, ShieldCheck, X } from '@lucide/vue';

const DISMISS_KEY = 'qy.welcome.dismissed';
const CHECKS_KEY = 'qy.welcome.checks';

interface Step {
  id: string;
  title: string;
  hint: string;
  to: string;
  icon: unknown;
  cta: string;
}

const steps: Step[] = [
  { id: 'settings', title: '完善站点信息', hint: '站名、简介、头像与页脚，出现在首页和 RSS 里', to: '/settings', icon: Settings, cta: '去设置' },
  { id: 'post', title: '写第一篇文章', hint: '支持 Markdown、草稿、定时发布与分类标签', to: '/posts/new', icon: FileText, cta: '去写文章' },
  { id: 'media', title: '上传封面和图片', hint: '图片会自动生成缩略图，链接可直接对外访问', to: '/media', icon: Image, cta: '去媒体库' },
  { id: 'comment', title: '看看评论和留言板', hint: '访客评论会汇总在这里，支持审核与回复', to: '/comments', icon: Bell, cta: '去查看' },
  { id: 'backup', title: '确认定时备份已开启', hint: '服务器上的 autobackup 会每天自动快照，只保留最近几份', to: '/backups', icon: ShieldCheck, cta: '去看备份' }
];

const router = useRouter();
const siteUrl = `${window.location.origin}/`;

function loadChecks(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(CHECKS_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

const checks = ref<Record<string, boolean>>(loadChecks());
const visible = ref<boolean>(localStorage.getItem(DISMISS_KEY) !== '1');

const doneCount = computed(() => steps.filter((s) => checks.value[s.id]).length);
const percent = computed(() => Math.round((doneCount.value / steps.length) * 100));
const allDone = computed(() => doneCount.value === steps.length);

function toggle(id: string) {
  checks.value = { ...checks.value, [id]: !checks.value[id] };
  localStorage.setItem(CHECKS_KEY, JSON.stringify(checks.value));
}

function dismiss() {
  localStorage.setItem(DISMISS_KEY, '1');
  visible.value = false;
}

function go(to: string) {
  router.push(to);
}

function reopen(): void {
  visible.value = true;
}

onMounted(() => window.addEventListener('qy:open-welcome', reopen));
onUnmounted(() => window.removeEventListener('qy:open-welcome', reopen));

function reset() {
  checks.value = {};
  localStorage.removeItem(CHECKS_KEY);
  visible.value = true;
}
</script>

<template>
  <Transition name="fade">
    <div v-if="visible" class="wy-backdrop" @click.self="dismiss">
      <section class="wy-card" role="dialog" aria-label="新站上手引导">
        <header class="wy-head">
          <div class="wy-title">
            <span class="wy-badge"><Rocket :size="16" /></span>
            <div>
              <h2>欢迎使用轻语博客</h2>
              <p>五步把新站变成能用的博客，勾掉的步骤会记住。</p>
            </div>
          </div>
          <button class="wy-close" title="不再显示" @click="dismiss">
            <X :size="18" />
          </button>
        </header>

        <div class="wy-progress">
          <div class="wy-bar"><i :style="{ width: percent + '%' }" /></div>
          <span class="wy-count">{{ doneCount }} / {{ steps.length }} 已完成</span>
        </div>

        <ul class="wy-list">
          <li v-for="step in steps" :key="step.id" :class="{ done: checks[step.id] }">
            <button class="wy-check" :aria-pressed="Boolean(checks[step.id])" @click="toggle(step.id)">
              <Check v-if="checks[step.id]" :size="14" />
            </button>
            <span class="wy-icon"><component :is="step.icon" :size="16" /></span>
            <div class="wy-text">
              <strong>{{ step.title }}</strong>
              <small>{{ step.hint }}</small>
            </div>
            <button class="btn btn-sm btn-secondary" @click="go(step.to)">{{ step.cta }}</button>
          </li>
        </ul>

        <footer class="wy-foot">
          <span class="wy-site">{{ siteUrl }}</span>
          <div class="wy-actions">
            <button class="btn btn-sm btn-ghost" @click="reset">重新开始</button>
            <button class="btn btn-primary" @click="dismiss">
              {{ allDone ? '全部完成，进入博客' : '稍后再看' }}
            </button>
          </div>
        </footer>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.wy-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(28, 25, 23, 0.42);
  backdrop-filter: blur(3px);
}

.wy-card {
  width: min(620px, 100%);
  max-height: 88vh;
  overflow: auto;
  padding: 22px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface);
  box-shadow: var(--shadow-lg);
}

.wy-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.wy-title {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.wy-badge {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  color: var(--accent);
  background: var(--accent-soft);
}

.wy-head h2 {
  margin: 0;
  font-size: 1.05rem;
  line-height: 1.4;
}

.wy-head p {
  margin: 2px 0 0;
  font-size: 0.82rem;
  color: var(--ink-muted);
}

.wy-close {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 8px;
  color: var(--ink-muted);
  background: transparent;
  cursor: pointer;
}

.wy-close:hover {
  color: var(--ink);
  background: var(--canvas);
}

.wy-progress {
  display: flex;
  gap: 10px;
  align-items: center;
  margin: 16px 0 6px;
}

.wy-bar {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: var(--border);
  overflow: hidden;
}

.wy-bar i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent), var(--accent-hover));
  transition: width 0.25s ease;
}

.wy-count {
  font-size: 0.76rem;
  color: var(--ink-muted);
  white-space: nowrap;
}

.wy-list {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 8px;
}

.wy-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  transition: border-color 0.15s ease, background 0.15s ease;
}

.wy-list li:hover {
  border-color: var(--border-strong);
}

.wy-list li.done {
  background: var(--success-soft);
  border-color: transparent;
}

.wy-list li.done .wy-text strong {
  text-decoration: line-through;
  color: var(--ink-muted);
}

.wy-check {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 1.5px solid var(--border-strong);
  border-radius: 6px;
  background: transparent;
  color: #fff;
  cursor: pointer;
  flex: none;
}

.wy-list li.done .wy-check {
  border-color: var(--success);
  background: var(--success);
}

.wy-icon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: var(--ink-soft);
  background: var(--canvas);
  flex: none;
}

.wy-text {
  flex: 1;
  min-width: 0;
}

.wy-text strong {
  display: block;
  font-size: 0.88rem;
}

.wy-text small {
  display: block;
  font-size: 0.75rem;
  color: var(--ink-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wy-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px dashed var(--border);
}

.wy-site {
  font-size: 0.76rem;
  color: var(--ink-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wy-actions {
  display: flex;
  gap: 8px;
  flex: none;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@media (max-width: 560px) {
  .wy-text small {
    white-space: normal;
  }
  .wy-foot {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>