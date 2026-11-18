<script setup lang="ts">
/** Explains a QuickBooks Desktop feature the SDK does not expose, and where to find it. */
import Message from 'primevue/message';
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { desktopOnlyFeature } from './features';

const route = useRoute();
const feature = computed(() => desktopOnlyFeature(String(route.params.feature ?? '')));
</script>

<template>
  <div class="desk" data-testid="desktop-only">
    <template v-if="feature">
      <div class="page-head">
        <h1>{{ feature.title }}</h1>
        <span class="page-sub">use QuickBooks Desktop</span>
      </div>
      <Message severity="info" :closable="false">
        {{ feature.title }} is only available in QuickBooks Desktop.
      </Message>
      <p>{{ feature.why }}</p>
      <p><strong>In QuickBooks Desktop:</strong> {{ feature.where }}</p>
      <template v-if="feature.instead?.length">
        <p><strong>Here instead:</strong></p>
        <ul>
          <li v-for="link in feature.instead" :key="link.to">
            <RouterLink :to="link.to">{{ link.label }}</RouterLink>
          </li>
        </ul>
      </template>
    </template>
    <Message v-else severity="warn" :closable="false">Unknown feature.</Message>
  </div>
</template>

<style scoped>
.desk {
  max-width: 44rem;
}
</style>
