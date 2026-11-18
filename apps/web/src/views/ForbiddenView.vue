<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router';
const route = useRoute();
</script>

<template>
  <div class="forbidden">
    <i class="pi pi-lock" aria-hidden="true" />
    <h1>Not allowed</h1>
    <p>
      Your role does not include access to <code>{{ route.query.from ?? 'this page' }}</code>. Ask
      an administrator.
    </p>
    <RouterLink to="/">Back to start</RouterLink>
  </div>
</template>

<style scoped>
.forbidden {
  padding: 3rem;
  text-align: center;
}
.forbidden .pi {
  font-size: 2rem;
  color: var(--p-text-muted-color);
}
</style>
