<script setup lang="ts">
/** Every catalog entity the user can read, grouped by area. */
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Tag from 'primevue/tag';
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { areaOf } from '@/lib/entities';
import { entityTitle, humanize } from '@/lib/labels';
import { entityListRoute } from '@/lib/links';
import { NAV_AREAS } from '@/modules/types';
import { useAuthStore } from '@/stores/auth';
import { useEventsStore } from '@/stores/events';
import { useMetaStore } from '@/stores/meta';

const meta = useMetaStore();
const auth = useAuthStore();
const events = useEventsStore();
const filter = ref('');
const error = ref<string | null>(null);

onMounted(() => {
  meta.loadEntities().catch((e: Error) => (error.value = e.message));
});

const groups = computed(() => {
  const f = filter.value.trim().toLowerCase();
  const list = meta.entities.filter(
    (e) =>
      (e.ops.query || e.unionQuery) &&
      auth.canRead(e.name) &&
      (!f || e.name.toLowerCase().includes(f) || humanize(e.name).toLowerCase().includes(f)),
  );
  return NAV_AREAS.map((area) => ({
    area,
    items: list.filter((e) => areaOf(e.name) === area).sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((g) => g.items.length);
});
</script>

<template>
  <div>
    <div class="page-head">
      <h1>Lists and transactions</h1>
      <div class="page-head__spacer" />
      <InputText v-model="filter" placeholder="Filter" aria-label="Filter types" />
    </div>
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    <section v-for="g in groups" :key="g.area" class="entity-index__group">
      <h2>{{ g.area }}</h2>
      <div class="entity-index__grid">
        <RouterLink
          v-for="e in g.items"
          :key="e.name"
          :to="entityListRoute(e.name)"
          class="entity-index__card"
          :data-entity="e.name"
        >
          <span class="entity-index__name">{{ entityTitle(e.name) }}</span>
          <span class="entity-index__tags">
            <Tag v-if="e.category === 'txn'" value="transaction" severity="secondary" />
            <Tag v-if="e.ops.add && auth.canWrite(e.name)" value="add" severity="info" />
            <Tag
              v-if="events.sync[e.name]"
              :value="events.sync[e.name]!.status"
              severity="contrast"
            />
          </span>
        </RouterLink>
      </div>
    </section>
    <p v-if="!groups.length && !error" class="page-sub">No types to show.</p>
  </div>
</template>

<style scoped>
.entity-index__group h2 {
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-muted-color);
  margin: 1.25rem 0 0.5rem;
}
.entity-index__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
  gap: 0.5rem;
}
.entity-index__card {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.7rem 0.8rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius);
  background: var(--p-content-background);
  color: var(--p-text-color);
  text-decoration: none;
}
.entity-index__card:hover {
  border-color: var(--p-primary-color);
}
.entity-index__name {
  font-weight: 600;
}
.entity-index__tags {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
}
</style>
