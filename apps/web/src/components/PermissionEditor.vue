<script setup lang="ts">
/**
 * Edits a permission list (roles and API tokens): global permissions,
 * per-entity read/write and free-form entries such as `report:ar-aging`.
 */
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import Chip from 'primevue/chip';
import InputText from 'primevue/inputtext';
import SelectButton from 'primevue/selectbutton';
import { computed, ref } from 'vue';
import { areaOf } from '@/lib/entities';
import { humanize } from '@/lib/labels';
import {
  GLOBAL_PERMISSIONS,
  hasPermission,
  isValidPermission,
  normalizePermissions,
  objectAccess,
  setObjectAccess,
  togglePermission,
  type ObjectAccess,
} from '@/lib/permissions';
import { useMetaStore } from '@/stores/meta';

const props = withDefaults(defineProps<{ modelValue: string[]; disabled?: boolean }>(), {
  disabled: false,
});
const emit = defineEmits<{ 'update:modelValue': [v: string[]] }>();

const meta = useMetaStore();
const filter = ref('');
const custom = ref('');
const customError = ref('');

const perms = computed(() => props.modelValue ?? []);
const isAdmin = computed(() => perms.value.includes('admin'));
const wildcard = computed(() => perms.value.filter((p) => p.startsWith('object:*:')));

const ACCESS = [
  { label: 'None', value: 'none' },
  { label: 'Read', value: 'read' },
  { label: 'Write', value: 'write' },
];

const rows = computed(() => {
  const f = filter.value.trim().toLowerCase();
  return meta.entities
    .filter(
      (e) => !f || e.name.toLowerCase().includes(f) || humanize(e.name).toLowerCase().includes(f),
    )
    .map((e) => ({
      name: e.name,
      label: humanize(e.name),
      area: areaOf(e.name),
      explicit: perms.value.includes(`object:${e.name}:write`)
        ? ('write' as ObjectAccess)
        : perms.value.includes(`object:${e.name}:read`)
          ? ('read' as ObjectAccess)
          : ('none' as ObjectAccess),
      effective: objectAccess(perms.value, e.name),
      writable: !!(e.ops.add || e.ops.mod || e.ops.del || e.ops.void),
    }))
    .sort((a, b) => a.area.localeCompare(b.area) || a.label.localeCompare(b.label));
});

const extras = computed(() =>
  perms.value.filter(
    (p) =>
      !GLOBAL_PERMISSIONS.some((g) => g.value === p) && !/^object:[A-Za-z]+:(read|write)$/.test(p),
  ),
);

function toggleGlobal(p: string, on: boolean) {
  emit('update:modelValue', togglePermission(perms.value, p, on));
}
function setAccess(type: string, a: ObjectAccess) {
  emit('update:modelValue', setObjectAccess(perms.value, type, a));
}
function addCustom() {
  const p = custom.value.trim();
  if (!isValidPermission(p)) {
    customError.value =
      'Use admin, command:read, qbxml:raw, report:<name|*> or object:<Type|*>:read|write';
    return;
  }
  customError.value = '';
  custom.value = '';
  emit('update:modelValue', normalizePermissions([...perms.value, p]));
}
function remove(p: string) {
  emit(
    'update:modelValue',
    perms.value.filter((x) => x !== p),
  );
}
const covered = (type: string, a: 'read' | 'write') =>
  hasPermission(wildcard.value, `object:${type}:${a}`);
</script>

<template>
  <div class="perm-editor">
    <section>
      <h4>General</h4>
      <div class="perm-editor__globals">
        <label v-for="g in GLOBAL_PERMISSIONS" :key="g.value" class="perm-editor__global">
          <Checkbox
            :model-value="perms.includes(g.value)"
            binary
            :disabled="disabled || (isAdmin && g.value !== 'admin')"
            :input-id="`perm-${g.value}`"
            @update:model-value="(v: boolean) => toggleGlobal(g.value, v)"
          />
          <span>
            <strong>{{ g.label }}</strong> <code>{{ g.value }}</code>
            <small>{{ g.description }}</small>
          </span>
        </label>
      </div>
    </section>

    <section v-if="!isAdmin">
      <h4>Lists and transactions</h4>
      <InputText
        v-model="filter"
        placeholder="Filter types"
        size="small"
        class="perm-editor__filter"
      />
      <div class="perm-editor__matrix">
        <table>
          <tbody>
            <tr v-for="r in rows" :key="r.name" :data-type="r.name">
              <td class="perm-editor__area">{{ r.area }}</td>
              <td>{{ r.label }}</td>
              <td>
                <SelectButton
                  :model-value="r.explicit"
                  :options="r.writable ? ACCESS : ACCESS.slice(0, 2)"
                  option-label="label"
                  option-value="value"
                  :allow-empty="false"
                  :disabled="disabled"
                  size="small"
                  @update:model-value="(a: ObjectAccess) => setAccess(r.name, a)"
                />
              </td>
              <td class="perm-editor__effective">
                <small
                  v-if="
                    r.effective !== r.explicit &&
                    (covered(r.name, 'read') || covered(r.name, 'write'))
                  "
                >
                  {{ r.effective }} via wildcard
                </small>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h4>Other permissions</h4>
      <div class="perm-editor__chips">
        <Chip v-for="p in extras" :key="p" :label="p" :removable="!disabled" @remove="remove(p)" />
        <span v-if="!extras.length" class="perm-editor__none">None</span>
      </div>
      <div class="perm-editor__custom">
        <InputText
          v-model="custom"
          placeholder="report:ar-aging"
          size="small"
          :disabled="disabled"
          @keydown.enter.prevent="addCustom"
        />
        <Button
          label="Add"
          size="small"
          text
          :disabled="disabled || !custom.trim()"
          @click="addCustom"
        />
      </div>
      <small v-if="customError" class="gf-error">{{ customError }}</small>
    </section>
  </div>
</template>

<style scoped>
.perm-editor h4 {
  margin: 0.75rem 0 0.4rem;
  font-size: 0.85rem;
}
.perm-editor__globals {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
  gap: 0.5rem;
}
.perm-editor__global {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
}
.perm-editor__global small {
  display: block;
  color: var(--p-text-muted-color);
}
.perm-editor__filter {
  margin-bottom: 0.4rem;
}
.perm-editor__matrix {
  max-height: 18rem;
  overflow: auto;
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius);
}
.perm-editor__matrix table {
  width: 100%;
  border-collapse: collapse;
}
.perm-editor__matrix td {
  padding: 0.2rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color);
}
.perm-editor__area,
.perm-editor__effective {
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
}
.perm-editor__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.perm-editor__none {
  color: var(--p-text-muted-color);
}
.perm-editor__custom {
  display: flex;
  gap: 0.4rem;
  margin-top: 0.4rem;
}
</style>
