<script setup lang="ts">
import { RouterLink } from 'vue-router';
</script>

<template>
  <div class="not-found">
    <h1>Page not found</h1>
    <RouterLink to="/">Back to start</RouterLink>
  </div>
</template>

<style scoped>
.not-found {
  padding: 3rem;
  text-align: center;
}
</style>
