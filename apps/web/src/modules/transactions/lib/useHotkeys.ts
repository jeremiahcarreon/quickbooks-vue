/**
 * Form keyboard shortcuts (QuickBooks Desktop habits):
 *   Ctrl/Cmd+S or Alt+S   save
 *   Alt+N                 save & new
 *   Ctrl+Insert           insert a line above the focused one
 *   Ctrl+Delete           delete the focused line
 *   Escape                close menus / cancel (left to the component)
 */
import { onBeforeUnmount, onMounted } from 'vue';

export interface Hotkeys {
  save?: () => void;
  saveNew?: () => void;
  insertLine?: () => void;
  deleteLine?: () => void;
}

export function hotkeyAction(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
): keyof Hotkeys | null {
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === 's') return 'save';
  if (e.altKey && !e.ctrlKey && key === 's') return 'save';
  if (e.altKey && !e.ctrlKey && key === 'n') return 'saveNew';
  if (e.ctrlKey && key === 'insert') return 'insertLine';
  if (e.ctrlKey && key === 'delete') return 'deleteLine';
  return null;
}

export function useHotkeys(keys: Hotkeys): void {
  const handler = (e: KeyboardEvent) => {
    const action = hotkeyAction(e);
    const fn = action ? keys[action] : undefined;
    if (fn) {
      e.preventDefault();
      fn();
    }
  };
  onMounted(() => window.addEventListener('keydown', handler));
  onBeforeUnmount(() => window.removeEventListener('keydown', handler));
}
