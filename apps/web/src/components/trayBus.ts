import { ref } from 'vue';

/** Lets any component open the command tray (optionally focused on one command). */
export const trayState = ref<{ open: boolean; focus: string | null }>({ open: false, focus: null });

export const trayBus = {
  open(focus?: string | null) {
    trayState.value = { open: true, focus: focus ?? null };
  },
  close() {
    trayState.value = { open: false, focus: null };
  },
};
