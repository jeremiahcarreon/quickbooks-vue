<script setup lang="ts">
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import MultiSelect from 'primevue/multiselect';
import Password from 'primevue/password';
import Tag from 'primevue/tag';
import ToggleSwitch from 'primevue/toggleswitch';
import { useToast } from 'primevue/usetoast';
import { onMounted, ref } from 'vue';
import { ApiError } from '@/api/client';
import { adminApi, type UserInput } from '@/api/endpoints';
import type { AdminUser, Role } from '@/api/types';
import { formatDate } from '@/lib/format';

const toast = useToast();
const users = ref<AdminUser[]>([]);
const roles = ref<Role[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

const dialog = ref(false);
const editing = ref<AdminUser | null>(null);
const form = ref({
  email: '',
  displayName: '',
  password: '',
  isActive: true,
  roles: [] as string[],
});
const formError = ref<string | null>(null);
const saving = ref(false);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    [users.value, roles.value] = await Promise.all([adminApi.users(), adminApi.roles()]);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function openNew() {
  editing.value = null;
  form.value = { email: '', displayName: '', password: '', isActive: true, roles: [] };
  formError.value = null;
  dialog.value = true;
}
function openEdit(u: AdminUser) {
  editing.value = u;
  // roles may come back as names or ids; match either
  const sel = roles.value
    .filter((r) => u.roles.includes(r.name) || u.roles.includes(r.id))
    .map((r) => r.id);
  form.value = {
    email: u.email,
    displayName: u.displayName,
    password: '',
    isActive: u.isActive,
    roles: sel,
  };
  formError.value = null;
  dialog.value = true;
}

async function save() {
  formError.value = null;
  const f = form.value;
  if (!editing.value && (!f.email || !f.password)) {
    formError.value = 'Email and an initial password are required.';
    return;
  }
  if (f.password && f.password.length < 12) {
    formError.value = 'Passwords need at least 12 characters.';
    return;
  }
  saving.value = true;
  try {
    const input: UserInput = { displayName: f.displayName, isActive: f.isActive, roles: f.roles };
    if (f.password) input.password = f.password;
    if (editing.value) await adminApi.updateUser(editing.value.id, input);
    else await adminApi.createUser({ ...input, email: f.email.trim() });
    dialog.value = false;
    toast.add({
      severity: 'success',
      summary: editing.value ? 'User updated' : 'User created',
      life: 2500,
    });
    await load();
  } catch (err) {
    formError.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

const roleName = (r: string) => roles.value.find((x) => x.id === r || x.name === r)?.name ?? r;
</script>

<template>
  <div>
    <div class="page-head">
      <h1>Users</h1>
      <div class="page-head__spacer" />
      <Button label="New user" icon="pi pi-plus" size="small" @click="openNew" />
    </div>
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    <DataTable
      :value="users"
      :loading="loading"
      data-key="id"
      size="small"
      striped-rows
      row-hover
      @row-click="(e) => openEdit(e.data)"
    >
      <Column field="displayName" header="Name" sortable />
      <Column field="email" header="Email" sortable />
      <Column header="Roles">
        <template #body="{ data }">
          <Tag
            v-for="r in data.roles"
            :key="r"
            :value="roleName(r)"
            severity="secondary"
            class="mr"
          />
        </template>
      </Column>
      <Column header="Active">
        <template #body="{ data }">
          <Tag
            :value="data.isActive ? 'active' : 'disabled'"
            :severity="data.isActive ? 'success' : 'danger'"
          />
        </template>
      </Column>
      <Column header="Last login">
        <template #body="{ data }">{{ formatDate(data.lastLoginAt) }}</template>
      </Column>
    </DataTable>

    <Dialog
      v-model:visible="dialog"
      :header="editing ? `Edit ${editing.email}` : 'New user'"
      modal
      :style="{ width: 'min(32rem, 95vw)' }"
    >
      <form class="admin-form" @submit.prevent="save">
        <Message v-if="formError" severity="error" :closable="false">{{ formError }}</Message>
        <label for="u-email">Email</label>
        <InputText
          id="u-email"
          v-model="form.email"
          type="email"
          :disabled="!!editing"
          autocomplete="off"
        />
        <label for="u-name">Display name</label>
        <InputText id="u-name" v-model="form.displayName" />
        <label for="u-pass">{{
          editing ? 'New password (leave empty to keep)' : 'Initial password'
        }}</label>
        <Password
          v-model="form.password"
          input-id="u-pass"
          toggle-mask
          :feedback="false"
          autocomplete="new-password"
        />
        <label for="u-roles">Roles</label>
        <MultiSelect
          id="u-roles"
          v-model="form.roles"
          :options="roles"
          option-label="name"
          option-value="id"
          display="chip"
        />
        <label class="admin-form__inline">
          <ToggleSwitch v-model="form.isActive" />
          <span>Active (inactive users cannot sign in)</span>
        </label>
        <div class="admin-form__actions">
          <Button label="Cancel" text severity="secondary" type="button" @click="dialog = false" />
          <Button label="Save" type="submit" :loading="saving" />
        </div>
      </form>
    </Dialog>
  </div>
</template>

<style scoped>
.mr {
  margin-right: 0.25rem;
}
</style>
