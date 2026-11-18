<script setup lang="ts">
/** Opens the object behind a ref whose type is one of several (ItemRef, EntityRef). */
import ProgressSpinner from 'primevue/progressspinner';
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { objectsApi } from '@/api/endpoints';
import { entityDetailRoute } from '@/lib/links';
import { useAuthStore } from '@/stores/auth';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const notFound = ref(false);

onMounted(async () => {
  const id = String(route.params.id);
  const types = String(route.query.types ?? '')
    .split(',')
    .filter((t) => t && auth.canRead(t));
  for (const t of types) {
    try {
      await objectsApi.get(t, id);
      await router.replace(entityDetailRoute(t, id));
      return;
    } catch {
      // try the next type
    }
  }
  notFound.value = true;
});
</script>

<template>
  <div class="ref-resolve">
    <p v-if="notFound">That record is not in the read model (yet), or you cannot see it.</p>
    <ProgressSpinner v-else style="width: 2rem; height: 2rem" />
  </div>
</template>

<style scoped>
.ref-resolve {
  padding: 2rem;
  text-align: center;
}
</style>
