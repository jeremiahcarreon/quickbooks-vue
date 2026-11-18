<script setup lang="ts">
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Tag from 'primevue/tag';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import { onMounted, ref } from 'vue';
import { ApiError } from '@/api/client';
import { adminApi } from '@/api/endpoints';
import type { ApiToken } from '@/api/types';
import DateInput from '@/components/DateInput.vue';
import PermissionEditor from '@/components/PermissionEditor.vue';
import { formatDate } from '@/lib/format';
import { useMetaStore } from '@/stores/meta';

const toast = useToast();
const confirm = useConfirm();
const meta = useMetaStore();
const tokens = ref<ApiToken[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const dialog = ref(false);
const form = ref({ name: '', permissions: [] as string[], expiresAt: null as string | null });
const formError = ref<string | null>(null);
const saving = ref(false);
/** The plain token, shown exactly once after creation. */
const created = ref<{ name: string; token: string } | null>(null);
const copied = ref(false);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    tokens.value = await adminApi.tokens();
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(() => {
  void load();
  void meta.loadEntities().catch(() => undefined);
});

function openNew() {
  form.value = { name: '', permissions: [], expiresAt: null };
  formError.value = null;
  dialog.value = true;
}
async function save() {
  if (!form.value.name.trim()) {
    formError.value = 'Give the token a name (which integration uses it).';
    return;
  }
  if (!form.value.permissions.length) {
    formError.value = 'Grant at least one permission.';
    return;
  }
  saving.value = true;
  formError.value = null;
  try {
    const res = await adminApi.createToken({
      name: form.value.name.trim(),
      permissions: form.value.permissions,
      expiresAt: form.value.expiresAt,
    });
    dialog.value = false;
    created.value = { name: form.value.name.trim(), token: res.token };
    copied.value = false;
    await load();
  } catch (err) {
    formError.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}
async function copy() {
  if (!created.value) return;
  try {
    await navigator.clipboard.writeText(created.value.token);
    copied.value = true;
  } catch {
    toast.add({
      severity: 'warn',
      summary: 'Copy failed',
      detail: 'Select the token and copy it manually.',
      life: 4000,
    });
  }
}
function closeCreated() {
  created.value = null;
}
function revoke(t: ApiToken) {
  confirm.require({
    header: `Revoke ${t.name}?`,
    message: 'Integrations using this token stop working immediately.',
    acceptProps: { label: 'Revoke', severity: 'danger' },
    rejectProps: { label: 'Cancel', severity: 'secondary', text: true },
    accept: async () => {
      try {
        await adminApi.revokeToken(t.id);
        toast.add({ severity: 'success', summary: 'Token revoked', life: 2500 });
        await load();
      } catch (err) {
        toast.add({
          severity: 'error',
          summary: 'Revoke failed',
          detail: (err as Error).message,
          life: 5000,
        });
      }
    },
  });
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1>API tokens</h1>
      <span class="page-sub"
        >For integrations: send <code>Authorization: Bearer &lt;token&gt;</code></span
      >
      <div class="page-head__spacer" />
      <Button label="New token" icon="pi pi-plus" size="small" @click="openNew" />
    </div>
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    <DataTable :value="tokens" :loading="loading" data-key="id" size="small" striped-rows>
      <Column field="name" header="Name" sortable />
      <Column header="Prefix">
        <template #body="{ data }"
          ><code>{{ data.tokenPrefix ?? '' }}…</code></template
        >
      </Column>
      <Column header="Permissions">
        <template #body="{ data }"
          ><code class="tokens__perms">{{ data.permissions.join(', ') }}</code></template
        >
      </Column>
      <Column header="Created"
        ><template #body="{ data }">{{ formatDate(data.createdAt) }}</template></Column
      >
      <Column header="Last used"
        ><template #body="{ data }">{{ formatDate(data.lastUsedAt) || 'never' }}</template></Column
      >
      <Column header="Expires"
        ><template #body="{ data }">{{ formatDate(data.expiresAt) || '—' }}</template></Column
      >
      <Column header="">
        <template #body="{ data }">
          <Tag v-if="data.revokedAt" value="revoked" severity="danger" />
          <Button v-else label="Revoke" size="small" text severity="danger" @click="revoke(data)" />
        </template>
      </Column>
    </DataTable>

    <Dialog
      v-model:visible="dialog"
      header="New API token"
      modal
      :style="{ width: 'min(52rem, 96vw)' }"
    >
      <form class="admin-form" @submit.prevent="save">
        <Message v-if="formError" severity="error" :closable="false">{{ formError }}</Message>
        <label for="t-name">Name</label>
        <InputText id="t-name" v-model="form.name" placeholder="e.g. Shopify order sync" />
        <label for="t-exp">Expires (optional)</label>
        <DateInput v-model="form.expiresAt" input-id="t-exp" />
        <PermissionEditor v-model="form.permissions" />
        <div class="admin-form__actions">
          <Button label="Cancel" text severity="secondary" type="button" @click="dialog = false" />
          <Button label="Create token" type="submit" :loading="saving" />
        </div>
      </form>
    </Dialog>

    <Dialog
      :visible="!!created"
      header="Copy your new token"
      modal
      :closable="false"
      :style="{ width: 'min(40rem, 96vw)' }"
    >
      <Message severity="warn" :closable="false"
        >This is the only time the token is shown. Store it in the integration's secret store
        now.</Message
      >
      <div class="tokens__secret">
        <InputText
          :model-value="created?.token ?? ''"
          readonly
          aria-label="New API token"
          data-testid="new-token"
          @focus="($event.target as HTMLInputElement).select()"
        />
        <Button
          :label="copied ? 'Copied' : 'Copy'"
          :icon="copied ? 'pi pi-check' : 'pi pi-copy'"
          @click="copy"
        />
      </div>
      <template #footer>
        <Button label="I have stored it" @click="closeCreated" />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.tokens__perms {
  font-size: 0.8rem;
  white-space: normal;
}
.tokens__secret {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
}
.tokens__secret :deep(input) {
  flex: 1;
  font-family: ui-monospace, monospace;
}
</style>
