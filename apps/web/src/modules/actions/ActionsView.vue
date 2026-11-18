<script setup lang="ts">
/**
 * SDK requests that are not an Add/Mod/Query/Del/Void of a list or
 * transaction: merge, cleared status, special accounts and items, display
 * requests, custom-field and subscription deletes, command exec and the
 * cross-type queries. The form comes from the request's ObjectDef; the API
 * builds the qbXML and validates it against the XSD before it is queued.
 */
import Button from 'primevue/button';
import Message from 'primevue/message';
import { computed, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { ApiError } from '@/api/client';
import { actionsApi, qbxmlIssues, type ActionDef, type LiveQueryResult } from '@/api/endpoints';
import ObjectForm from '@/components/ObjectForm.vue';
import ObjectView from '@/components/ObjectView.vue';
import { toBody, type FormValue } from '@/forms/model';
import { humanize } from '@/lib/labels';
import { useMetaStore } from '@/stores/meta';
import { ACTION_HELP } from './labels';

const route = useRoute();
const meta = useMetaStore();

const actions = ref<ActionDef[]>([]);
const loadError = ref<string | null>(null);
const name = computed(() => (route.params.name ? String(route.params.name) : ''));
const current = computed(() => actions.value.find((a) => a.name === name.value));

const value = ref<FormValue>({});
const ready = ref(false);
const running = ref(false);
const failure = ref<string | null>(null);
const result = ref<LiveQueryResult | null>(null);

const label = (n: string) => humanize(n.replace(/Rq$/, ''));

actionsApi
  .list()
  .then((list) => (actions.value = list))
  .catch((err: Error) => (loadError.value = err.message));

watch(
  name,
  async (n) => {
    value.value = {};
    result.value = null;
    failure.value = null;
    ready.value = false;
    if (!n) return;
    try {
      await meta.loadEntities().catch(() => undefined);
      await meta.ensureObjects([n]);
      ready.value = !!meta.objects[n];
    } catch (err) {
      failure.value = (err as Error).message;
    }
  },
  { immediate: true },
);

async function send() {
  if (!name.value) return;
  failure.value = null;
  result.value = null;
  running.value = true;
  try {
    const body = toBody(name.value, value.value, meta.ctx()) ?? {};
    result.value = await actionsApi.run(name.value, body);
  } catch (err) {
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
</script>

<template>
  <div>
    <div class="page-head">
      <RouterLink v-if="name" :to="{ name: 'sdk-actions' }" class="page-sub"
        >QuickBooks actions</RouterLink
      >
      <span v-if="name" class="page-sub">/</span>
      <h1>{{ name ? label(name) : 'QuickBooks actions' }}</h1>
    </div>
    <Message v-if="loadError" severity="warn" :closable="false">{{ loadError }}</Message>

    <ul v-if="!name" class="actions" data-testid="actions-list">
      <li v-for="a in actions" :key="a.name" :class="{ 'actions__item--off': !a.allowed }">
        <RouterLink v-if="a.allowed" :to="{ name: 'sdk-actions', params: { name: a.name } }">
          {{ label(a.name) }}
        </RouterLink>
        <span v-else>{{ label(a.name) }}</span>
        <span class="page-sub">{{ ACTION_HELP[a.name] ?? a.name }}</span>
        <span v-if="!a.allowed" class="page-sub">Needs {{ a.permissions.join(', ') }}</span>
      </li>
    </ul>

    <template v-else>
      <p class="page-sub">{{ ACTION_HELP[name] ?? name }}</p>
      <Message v-if="current && !current.allowed" severity="warn" :closable="false">
        You need {{ current.permissions.join(', ') }} to send this.
      </Message>
      <form v-if="ready" class="actions__form" @submit.prevent="send">
        <ObjectForm v-model="value" :object="name" />
        <div>
          <Button
            type="submit"
            label="Send to QuickBooks"
            icon="pi pi-send"
            size="small"
            :loading="running"
            :disabled="current ? !current.allowed : false"
            data-testid="action-send"
          />
        </div>
      </form>
      <Message v-if="failure" severity="error" :closable="false" data-testid="action-error">
        {{ failure }}
      </Message>
      <template v-if="result">
        <Message v-if="result.pending" severity="warn" :closable="false">
          Queued as command {{ result.commandId }}; QuickBooks has not answered yet.
        </Message>
        <div v-for="(rs, i) in result.responses" :key="i" data-testid="action-result">
          <Message
            :severity="rs.statusCode === 0 || rs.statusCode === 1 ? 'success' : 'warn'"
            :closable="false"
          >
            {{ rs.statusMessage || rs.name }} ({{ rs.statusCode }})
          </Message>
          <div v-for="(ret, j) in rs.rets" :key="j" class="actions__ret">
            <ObjectView :data="ret" :object="rs.retNames[j]" />
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.actions {
  list-style: none;
  padding: 0;
  display: grid;
  gap: 0.75rem;
}
.actions li {
  display: grid;
  gap: 0.15rem;
}
.actions__item--off {
  opacity: 0.6;
}
.actions__form {
  display: grid;
  gap: 0.75rem;
}
.actions__ret {
  border: 1px solid var(--p-content-border-color, #ddd);
  border-radius: 6px;
  padding: 0.75rem;
  margin-top: 0.5rem;
}
</style>
