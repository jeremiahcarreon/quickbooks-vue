<script setup lang="ts">
/**
 * Live command tray: queued and in-flight writes, failures and conflicts.
 * A conflict expands into the field diff with "reload and reapply".
 */
import Button from 'primevue/button';
import Drawer from 'primevue/drawer';
import OverlayBadge from 'primevue/overlaybadge';
import { useToast } from 'primevue/usetoast';
import { computed, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { reapply } from '@/forms/model';
import { timeAgo } from '@/lib/format';
import { entityDetailRoute, entityEditRoute } from '@/lib/links';
import { useCommandsStore, type TrackedCommand } from '@/stores/commands';
import { useDraftsStore } from '@/stores/drafts';
import { useMetaStore } from '@/stores/meta';
import ConflictDiff from '../ConflictDiff.vue';
import PendingBadge from '../PendingBadge.vue';
import { trayBus, trayState } from '../trayBus';

const commands = useCommandsStore();
const drafts = useDraftsStore();
const meta = useMetaStore();
const router = useRouter();
const toast = useToast();

const visible = computed({
  get: () => trayState.value.open,
  set: (v: boolean) => (v ? trayBus.open() : trayBus.close()),
});
const expanded = ref<string | null>(null);
watch(
  () => trayState.value.focus,
  (f) => {
    if (f) expanded.value = f;
  },
);

const problems = computed(() => commands.problems);
const active = computed(() => commands.active);
const recent = computed(() =>
  commands.visible.filter((c) => c.status === 'succeeded').slice(0, 15),
);

function objectRoute(c: TrackedCommand) {
  const id =
    c.objectId ?? (c.result?.qbId as string | undefined) ?? (c.result?.id as string | undefined);
  return c.entity && id && c.op !== 'del' ? entityDetailRoute(c.entity, id) : null;
}

async function onReapply(c: TrackedCommand) {
  const current = (c.result as Record<string, unknown> | null)?.current as
    Record<string, unknown> | undefined;
  if (!c.entity || !c.objectId || !c.formObject || !current || !c.submitted) return;
  try {
    await meta.loadEntity(c.entity);
    const value = reapply(c.formObject, current, c.submitted, meta.ctx(c.entity));
    drafts.put(c.entity, c.objectId, {
      value,
      base: current,
      note: 'Your changes were reapplied on top of the latest version from QuickBooks. Review and save.',
      fromCommand: c.id,
    });
    commands.dismiss(c.id);
    trayBus.close();
    await router.push(entityEditRoute(c.entity, c.objectId));
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Could not reapply',
      detail: (err as Error).message,
      life: 6000,
    });
  }
}
</script>

<template>
  <OverlayBadge
    v-if="commands.badgeCount"
    :value="commands.badgeCount"
    :severity="problems.length ? 'danger' : 'info'"
    size="small"
  >
    <Button
      icon="pi pi-inbox"
      text
      rounded
      aria-label="Command tray"
      data-testid="tray-button"
      @click="trayBus.open()"
    />
  </OverlayBadge>
  <Button
    v-else
    icon="pi pi-inbox"
    text
    rounded
    aria-label="Command tray"
    data-testid="tray-button"
    @click="trayBus.open()"
  />

  <Drawer
    v-model:visible="visible"
    position="right"
    header="QuickBooks writes"
    class="command-tray"
    :style="{ width: 'min(36rem, 100vw)' }"
  >
    <section v-if="problems.length">
      <h3>Needs attention</h3>
      <ul class="command-tray__list">
        <li
          v-for="c in problems"
          :key="c.id"
          :data-command="c.id"
          :class="`command-tray__item--${c.status}`"
        >
          <div class="command-tray__row">
            <PendingBadge :status="c.status" />
            <span class="command-tray__label">{{ c.label }}</span>
            <small>{{ timeAgo(new Date(c.updatedAt).toISOString()) }}</small>
          </div>
          <p v-if="c.statusMessage" class="command-tray__msg">
            <span v-if="c.statusCode !== null">[{{ c.statusCode }}]</span> {{ c.statusMessage }}
          </p>
          <div class="command-tray__actions">
            <RouterLink v-if="objectRoute(c)" :to="objectRoute(c)!" @click="trayBus.close()"
              >Open</RouterLink
            >
            <Button
              v-if="c.status === 'conflict'"
              :label="expanded === c.id ? 'Hide differences' : 'Resolve'"
              size="small"
              text
              @click="expanded = expanded === c.id ? null : c.id"
            />
            <Button
              label="Dismiss"
              size="small"
              text
              severity="secondary"
              @click="commands.dismiss(c.id)"
            />
          </div>
          <ConflictDiff
            v-if="c.status === 'conflict' && expanded === c.id"
            :command="c"
            @reapply="onReapply"
            @discard="commands.dismiss(c.id)"
          />
        </li>
      </ul>
    </section>

    <section>
      <h3>In progress</h3>
      <ul v-if="active.length" class="command-tray__list">
        <li v-for="c in active" :key="c.id" :data-command="c.id">
          <div class="command-tray__row">
            <PendingBadge :status="c.status" />
            <span class="command-tray__label">{{ c.label }}</span>
            <small>{{ timeAgo(new Date(c.createdAt).toISOString()) }}</small>
          </div>
        </li>
      </ul>
      <p v-else class="command-tray__empty">Nothing waiting on QuickBooks.</p>
    </section>

    <section v-if="recent.length">
      <h3>
        Done
        <Button
          label="Clear"
          size="small"
          text
          severity="secondary"
          @click="commands.clearFinished()"
        />
      </h3>
      <ul class="command-tray__list">
        <li v-for="c in recent" :key="c.id" :data-command="c.id">
          <div class="command-tray__row">
            <PendingBadge status="succeeded" />
            <RouterLink
              v-if="objectRoute(c)"
              :to="objectRoute(c)!"
              class="command-tray__label"
              @click="trayBus.close()"
            >
              {{ c.label }}
            </RouterLink>
            <span v-else class="command-tray__label">{{ c.label }}</span>
            <small>{{ timeAgo(new Date(c.updatedAt).toISOString()) }}</small>
          </div>
        </li>
      </ul>
    </section>
  </Drawer>
</template>

<style scoped>
h3 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-muted-color);
  margin: 1rem 0 0.4rem;
}
.command-tray__list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.command-tray__list li {
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--p-content-border-color);
}
.command-tray__row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.command-tray__label {
  flex: 1;
}
.command-tray__row small {
  color: var(--p-text-muted-color);
}
.command-tray__msg {
  margin: 0.3rem 0 0;
  font-size: 0.85rem;
}
.command-tray__actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-top: 0.25rem;
}
.command-tray__empty {
  color: var(--p-text-muted-color);
}
</style>
