<script setup lang="ts">
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import { useToast } from 'primevue/usetoast';
import { onMounted, ref } from 'vue';
import { ApiError } from '@/api/client';
import { adminApi } from '@/api/endpoints';
import type { Role } from '@/api/types';
import PermissionEditor from '@/components/PermissionEditor.vue';
import { useMetaStore } from '@/stores/meta';

const toast = useToast();
const meta = useMetaStore();
const roles = ref<Role[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const dialog = ref(false);
const editing = ref<Role | null>(null);
const form = ref({ name: '', description: '', permissions: [] as string[] });
const formError = ref<string | null>(null);
const saving = ref(false);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    roles.value = await adminApi.roles();
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
  editing.value = null;
  form.value = { name: '', description: '', permissions: [] };
  formError.value = null;
  dialog.value = true;
}
function openEdit(r: Role) {
  editing.value = r;
  form.value = { name: r.name, description: r.description, permissions: [...r.permissions] };
  formError.value = null;
  dialog.value = true;
}
async function save() {
  if (!form.value.name.trim()) {
    formError.value = 'A role needs a name.';
    return;
  }
  saving.value = true;
  formError.value = null;
  try {
    const input = {
      name: form.value.name.trim(),
      description: form.value.description,
      permissions: form.value.permissions,
    };
    if (editing.value) await adminApi.updateRole(editing.value.id, input);
    else await adminApi.createRole(input);
    dialog.value = false;
    toast.add({ severity: 'success', summary: 'Role saved', life: 2500 });
    await load();
  } catch (err) {
    formError.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1>Roles</h1>
      <div class="page-head__spacer" />
      <Button label="New role" icon="pi pi-plus" size="small" @click="openNew" />
    </div>
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    <DataTable
      :value="roles"
      :loading="loading"
      data-key="id"
      size="small"
      striped-rows
      row-hover
      @row-click="(e) => openEdit(e.data)"
    >
      <Column field="name" header="Role" sortable />
      <Column field="description" header="Description" />
      <Column header="Permissions">
        <template #body="{ data }">
          <code class="roles__perms">{{ data.permissions.join(', ') }}</code>
        </template>
      </Column>
    </DataTable>

    <Dialog
      v-model:visible="dialog"
      :header="editing ? `Edit role ${editing.name}` : 'New role'"
      modal
      :style="{ width: 'min(52rem, 96vw)' }"
    >
      <form class="admin-form" @submit.prevent="save">
        <Message v-if="formError" severity="error" :closable="false">{{ formError }}</Message>
        <label for="r-name">Name</label>
        <InputText id="r-name" v-model="form.name" />
        <label for="r-desc">Description</label>
        <InputText id="r-desc" v-model="form.description" />
        <PermissionEditor v-model="form.permissions" />
        <div class="admin-form__actions">
          <Button label="Cancel" text severity="secondary" type="button" @click="dialog = false" />
          <Button label="Save" type="submit" :loading="saving" />
        </div>
      </form>
    </Dialog>
  </div>
</template>

<style scoped>
.roles__perms {
  font-size: 0.8rem;
  white-space: normal;
}
</style>
