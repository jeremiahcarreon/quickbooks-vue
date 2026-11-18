<script setup lang="ts">
/** Every purpose-built form, grouped like the QuickBooks home page. */
import { RouterLink } from 'vue-router';
import { nav } from '../index';

const AREAS = ['Customers', 'Vendors', 'Banking', 'Company'] as const;
const groups = AREAS.map((area) => ({
  area,
  items: nav.filter((n) => n.area === area).sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
}));
</script>

<template>
  <section class="hub">
    <h1>Transactions</h1>
    <div class="hub__grid">
      <div v-for="g in groups" :key="g.area" class="hub__group">
        <h2>{{ g.area }}</h2>
        <RouterLink v-for="i in g.items" :key="i.to" :to="i.to" class="hub__link">
          <i :class="i.icon" aria-hidden="true" />
          <span>{{ i.label }}</span>
        </RouterLink>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hub h1 {
  margin: 0 0 1rem;
  font-size: 1.4rem;
}
.hub__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
  gap: 1rem;
}
.hub__group {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.75rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius);
  background: var(--p-content-background);
}
.hub__group h2 {
  margin: 0 0 0.4rem;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-muted-color);
}
.hub__link {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  padding: 0.35rem 0.4rem;
  border-radius: var(--p-content-border-radius);
  color: var(--p-text-color);
  text-decoration: none;
}
.hub__link:hover,
.hub__link:focus-visible {
  background: var(--p-content-hover-background);
}
</style>
