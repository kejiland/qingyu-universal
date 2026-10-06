<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AdminLayout from './components/layout/AdminLayout.vue';
import ToastHost from './components/ui/ToastHost.vue';
import WelcomeGuide from './components/WelcomeGuide.vue';
import { session } from './lib/api';

const route = useRoute();
const showLayout = computed(() => route.name !== 'login' && Boolean(session.token));
</script>

<template>
  <AdminLayout v-if="showLayout">
    <RouterView v-slot="{ Component }">
      <Transition name="page" mode="out-in">
        <component :is="Component" />
      </Transition>
    </RouterView>
  </AdminLayout>

  <RouterView v-else />

  <WelcomeGuide v-if="showLayout" />

  <ToastHost />
</template>

<style>
.page-enter-active,
.page-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.page-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.page-leave-to {
  opacity: 0;
}
</style>