<script setup lang="ts">
/** Link to the object a `...Ref` value points at. */
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { refTargets } from '@/lib/entities';
import { refRoute } from '@/lib/links';
import { useMetaStore } from '@/stores/meta';

const props = withDefaults(
  defineProps<{ field: string; value: unknown; owner?: string; targets?: string[] }>(),
  { owner: undefined, targets: undefined },
);
const meta = useMetaStore();
const ref_ = computed(() =>
  props.value && typeof props.value === 'object' ? (props.value as Record<string, unknown>) : {},
);
const id = computed(() => (typeof ref_.value.ListID === 'string' ? ref_.value.ListID : ''));
const label = computed(() => String(ref_.value.FullName ?? ref_.value.ListID ?? ''));
const to = computed(() => {
  const t = props.targets ?? refTargets(props.field, meta.entityNames, props.owner);
  return id.value && t.length ? refRoute(t, id.value) : null;
});
</script>

<template>
  <RouterLink v-if="to" :to="to" class="ref-link">{{ label }}</RouterLink>
  <span v-else>{{ label }}</span>
</template>
