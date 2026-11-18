<script setup lang="ts">
/**
 * Live query for an entity the read model cannot hold: its query needs
 * filters (BillToPay per vendor, ItemAssembliesCanBuild per assembly and date,
 * SalesTaxReturnLine per tax agency, subscriptions per subscriber, ...). The
 * filter form is generated from the query request's ObjectDef; the server
 * builds the qbXML and validates it against the XSD before QuickBooks sees it.
 */
import Button from 'primevue/button';
import Message from 'primevue/message';
import { computed, ref, watch } from 'vue';
import { ApiError } from '@/api/client';
import { objectsApi, qbxmlIssues, type LiveQueryResult } from '@/api/endpoints';
import type { EntityDef } from '@/api/types';
import ObjectForm from '@/components/ObjectForm.vue';
import ObjectView from '@/components/ObjectView.vue';
import {
  activeFields,
  describeObject,
  isEmptyValue,
  toBody,
  type ErrorMap,
  type FormValue,
} from '@/forms/model';
import { humanize } from '@/lib/labels';
import { useMetaStore } from '@/stores/meta';

const props = defineProps<{ entity: EntityDef }>();
const meta = useMetaStore();

const rq = computed(() => props.entity.ops.query ?? props.entity.unionQuery ?? '');
const value = ref<FormValue>({});
const errors = ref<ErrorMap>({});
const ready = ref(false);
const running = ref(false);
const failure = ref<string | null>(null);
const result = ref<LiveQueryResult | null>(null);

watch(
  rq,
  async (name) => {
    ready.value = false;
    value.value = {};
    result.value = null;
    if (!name) return;
    try {
      await meta.ensureObjects([name, props.entity.retElement]);
      ready.value = !!meta.objects[name];
    } catch (err) {
      failure.value = (err as Error).message;
    }
  },
  { immediate: true },
);

const required = computed(() => props.entity.requiredFilters ?? []);

/** Required top-level filters left empty, as field errors. */
function missing(): ErrorMap {
  const out: ErrorMap = {};
  try {
    const form = describeObject(rq.value, meta.ctx(props.entity.name));
    for (const f of activeFields(form, value.value)) {
      if (f.required && isEmptyValue(value.value[f.name])) out[f.name] = 'Required';
    }
  } catch {
    // no form definition: let the server's XSD check report it
  }
  return out;
}

async function run() {
  failure.value = null;
  errors.value = missing();
  if (Object.keys(errors.value).length) return;
  running.value = true;
  try {
    const body = toBody(rq.value, value.value, meta.ctx(props.entity.name)) ?? {};
    result.value = await objectsApi.live(props.entity.name, body);
  } catch (err) {
    result.value = null;
    if (err instanceof ApiError && err.status === 400) {
      const issues = qbxmlIssues(err.details);
      failure.value = issues.length
        ? `${err.message}: ${issues.map((i) => i.message).join('; ')}`
        : err.message;
    } else {
      failure.value = (err as Error).message;
    }
  } finally {
    running.value = false;
  }
}

const status = computed(() => result.value?.responses[0]);
</script>

<template>
  <section class="live" data-testid="live-query">
    <Message severity="info" :closable="false">
      QuickBooks only returns {{ humanize(entity.name) }} for a given
      {{ required.map(humanize).join(', ') || 'filter' }}, so it is not kept in the read model. Fill
      in the filter and ask QuickBooks directly.
    </Message>
    <form v-if="ready" class="live__form" @submit.prevent="run">
      <ObjectForm v-model="value" :object="rq" :owner="entity.name" :errors="errors" />
      <div>
        <Button
          type="submit"
          label="Ask QuickBooks"
          icon="pi pi-search"
          size="small"
          :loading="running"
          data-testid="live-run"
        />
      </div>
    </form>
    <Message v-if="failure" severity="error" :closable="false" data-testid="live-error">
      {{ failure }}
    </Message>
    <template v-if="result">
      <Message v-if="result.pending" severity="warn" :closable="false">
        QuickBooks has not answered yet (command {{ result.commandId }}). Try again shortly.
      </Message>
      <Message
        v-else-if="status && status.statusCode !== 0 && status.statusCode !== 1"
        severity="warn"
        :closable="false"
      >
        {{ status.statusMessage }}
      </Message>
      <p v-else class="page-sub" data-testid="live-count">
        {{ result.items.length }} returned by QuickBooks
      </p>
      <div v-for="(item, i) in result.items" :key="i" class="live__item">
        <ObjectView :data="item" :object="entity.retElement" :owner="entity.name" />
      </div>
    </template>
  </section>
</template>

<style scoped>
.live {
  display: grid;
  gap: 1rem;
}
.live__form {
  display: grid;
  gap: 0.75rem;
}
.live__item {
  border: 1px solid var(--p-content-border-color, #ddd);
  border-radius: 6px;
  padding: 0.75rem;
}
</style>
