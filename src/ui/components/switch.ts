/**
 * Shared toggle switch (redesign IA, screen 4) — replaces raw checkboxes for
 * metric visibility and import options. A `role="switch"` button so it is
 * keyboard- and screen-reader-accessible; styling lives in `.switch`
 * (styles.css). Toggling updates only this element's own state — it never
 * triggers a view re-render (the flicker the redesign removes).
 */

export interface SwitchOptions {
  /** Initial on/off state. */
  checked: boolean;
  /** Accessible label (the visible label sits next to the switch in the row). */
  label: string;
  /** Called with the new state after each user toggle. */
  onChange: (checked: boolean) => void;
  /** Optional: disable interaction. */
  disabled?: boolean;
}

export interface SwitchControl {
  el: HTMLButtonElement;
  /** Current state. */
  isOn: () => boolean;
  /** Set state programmatically without firing `onChange`. */
  set: (checked: boolean) => void;
}

export function switchControl(opts: SwitchOptions): SwitchControl {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'switch';
  el.setAttribute('role', 'switch');
  el.setAttribute('aria-label', opts.label);
  if (opts.disabled) el.disabled = true;

  let checked = opts.checked;
  const paint = (): void => {
    el.setAttribute('aria-checked', String(checked));
  };
  paint();

  el.addEventListener('click', () => {
    if (el.disabled) return;
    checked = !checked;
    paint();
    opts.onChange(checked);
  });

  return {
    el,
    isOn: () => checked,
    set: (next: boolean) => {
      checked = next;
      paint();
    },
  };
}
