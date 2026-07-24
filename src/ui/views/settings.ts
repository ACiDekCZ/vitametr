/**
 * Settings screen (redesign IA, screen 3) — application settings only.
 *
 * A slim, sectioned list scoped to the *app* itself: language, security
 * (app password + auto-lock + lock now), measurement sources, backup export
 * and the destructive "delete all data" zone. Everything about *data* — import,
 * the metric catalog, aliases and packs — now lives on its own first-class
 * pages (Import, Veličiny), so this view no longer renders any of it.
 *
 * Each section is a white card with an uppercase, faint group heading and
 * divider-separated rows; navigational rows carry a chevron and open a modal
 * sub-view on demand (the password forms and the sources manager are modal
 * `<dialog>`s in the top layer, so they survive any re-render). There is no
 * blanket view re-render: a language change re-renders the app (locale is
 * global), a source add repaints only the modal list and the summary count,
 * and a password change repaints only the security card. This kills the
 * whole-view flicker the redesign removes.
 *
 * All user-facing text goes through `ctx.t`. The only literal strings are the
 * language endonyms ("CS"/"EN" acronyms) and the license identifier
 * ("MPL 2.0") — proper-noun/version-style literals with no i18n key, mirroring
 * the existing convention (see app.ts / import-model.ts). Destructive actions
 * are guarded by an in-view double confirmation — no native confirm/alert.
 */

import './settings.css';
import type { AppContext, View } from '../app-context';
import { WrongPassphraseError } from '../../core/contracts';
import type { ExportContext, ExportSelection } from '../../core/contracts';
import type { ProfileSettings, Source, SourceKind, UnitSystem } from '../../core/types';
import type { StringKey } from '../../i18n/index';
import { applyTheme, animateThemeChange } from '../theme';
import { exportPluginById } from '../../plugins/registry';
import { LOINC_ATTRIBUTION } from '../../core/catalog-data';
import { switchControl } from '../components/switch';
import {
  autoLockOptions,
  buildExportFilename,
  buildSource,
  profileDisplayName,
  securityActions,
  sourceKindOptions,
  sourceNameExists,
  validateNewPassphrase,
  type EncryptionMode,
  type ExportKind,
} from './settings-model';

// Compile-time app version + build id injected by the bundler; falls back in raw
// dev runs. The build id carries a per-build suffix on staging/dev, so the footer
// visibly changes on every deploy — a quick "am I on the new build?" check.
declare const __APP_VERSION__: string;
declare const __BUILD_ID__: string;
function appVersion(): string {
  if (typeof __BUILD_ID__ !== 'undefined' && __BUILD_ID__) return __BUILD_ID__;
  return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0-dev';
}

const DEFAULT_AUTO_LOCK_MINUTES = 10;

// License identifier shown in the footer — a fixed proper-noun literal (like the
// app version), so it carries no i18n key.
const LICENSE = 'MPL 2.0';

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function textEl(tag: string, text: string, className?: string): HTMLElement {
  const node = el(tag, className);
  node.textContent = text;
  return node;
}

function button(label: string, className?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (className) b.className = className;
  return b;
}

function field(labelText: string): { wrap: HTMLElement; label: HTMLLabelElement } {
  const wrap = el('div', 'field');
  const label = document.createElement('label');
  label.textContent = labelText;
  wrap.append(label);
  return { wrap, label };
}

function passwordInput(ariaLabel: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'password';
  input.setAttribute('aria-label', ariaLabel);
  return input;
}

function inlineError(): HTMLElement {
  const p = el('p', 'settings-error pill above');
  p.style.display = 'none';
  return p;
}

function showError(node: HTMLElement, message: string): void {
  node.textContent = message;
  node.style.display = '';
}

function clearError(node: HTMLElement): void {
  node.textContent = '';
  node.style.display = 'none';
}

/** A white section card with an uppercase, faint group heading and a body. */
function groupCard(titleKey: StringKey, t: AppContext['t']): { card: HTMLElement; body: HTMLElement } {
  const card = el('section', 'settings-group');
  card.append(textEl('h2', t(titleKey), 'settings-group-title'));
  const body = el('div', 'settings-group-body');
  card.append(body);
  return { card, body };
}

/** A navigational row: label (+ optional meta) on the left, a chevron on the right. */
function navRow(label: string, meta?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'settings-row settings-row-nav';
  const text = el('span', 'settings-row-text');
  text.append(textEl('span', label, 'settings-row-label'));
  if (meta) text.append(textEl('span', meta, 'settings-row-meta muted'));
  b.append(text);
  const chev = textEl('span', '›', 'settings-row-chevron');
  chev.setAttribute('aria-hidden', 'true');
  b.append(chev);
  return b;
}

// ---------------------------------------------------------------------------
// Trust banner
// ---------------------------------------------------------------------------

/** Trust banner: soft accent→teal gradient, lock glyph, on-device privacy copy. */
function renderTrustBanner(ctx: AppContext): HTMLElement {
  const banner = el('div', 'settings-trust');

  const lock = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  lock.setAttribute('viewBox', '0 0 24 24');
  lock.setAttribute('class', 'settings-trust-lock');
  lock.setAttribute('aria-hidden', 'true');
  const body = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  body.setAttribute('x', '5');
  body.setAttribute('y', '10');
  body.setAttribute('width', '14');
  body.setAttribute('height', '10');
  body.setAttribute('rx', '3');
  const shackle = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shackle.setAttribute('d', 'M8 10 V7 a4 4 0 0 1 8 0 v3');
  lock.append(body, shackle);

  // Default to the plaintext copy (always true) and upgrade to the "encrypted
  // with a passphrase" claim only once the store confirms a password is set —
  // so a false encryption claim never shows, not even for a frame.
  const text = textEl('p', ctx.t('settings.trustBannerPlain'), 'settings-trust-text');
  banner.append(lock, text);
  void ctx.store.mode().then((mode: EncryptionMode) => {
    if (mode === 'encrypted') text.textContent = ctx.t('settings.trustBanner');
  }, () => {});
  return banner;
}

// ---------------------------------------------------------------------------
// Application: language
// ---------------------------------------------------------------------------

function renderLanguageSection(ctx: AppContext): HTMLElement {
  const { card, body } = groupCard('settings.app', ctx.t);
  const row = el('div', 'settings-row');
  row.append(textEl('span', ctx.t('settings.language'), 'settings-row-label'));

  // Inline CS/EN segmented control (container --surface-2, active white + shadow).
  const seg = el('div', 'settings-segment');
  const langs: { locale: 'cs' | 'en'; label: string }[] = [
    { locale: 'cs', label: 'CS' },
    { locale: 'en', label: 'EN' },
  ];
  for (const { locale, label } of langs) {
    const b = button(label, 'settings-segment-btn');
    if (ctx.locale === locale) {
      b.classList.add('is-active');
      b.setAttribute('aria-current', 'true');
    }
    b.addEventListener('click', () => {
      if (ctx.locale !== locale) ctx.setLocale(locale);
    });
    seg.append(b);
  }
  row.append(seg);
  body.append(row);

  // Appearance: Auto / Light / Dark, applied instantly (attribute swap).
  body.append(renderAppearanceRow(ctx));

  // Units: a global unit-system preference, independent of the language above.
  body.append(renderUnitSystemRow(ctx));

  // "Use tags" switch: groups the overview by tag and shows tag filters/chips.
  const tagsRow = el('div', 'settings-row');
  const tagsText = el('span', 'settings-row-text');
  tagsText.append(textEl('span', ctx.t('settings.useTags'), 'settings-row-label'));
  tagsText.append(textEl('span', ctx.t('settings.useTagsHint'), 'settings-row-meta muted'));
  const tagsSwitch = switchControl({
    checked: ctx.data().settings.useTags !== false,
    label: ctx.t('settings.useTags'),
    onChange: (on) => {
      ctx.mutate((d) => {
        d.settings.useTags = on;
      });
    },
  });
  tagsRow.append(tagsText, tagsSwitch.el);
  body.append(tagsRow);

  // "Show under every tag" switch: only relevant when tags are on, so it is
  // rendered only then. Groups each metric under every tag it carries (instead
  // of only its primary tag), so a custom tag forms its own overview section.
  if (ctx.data().settings.useTags !== false) {
    const allTagsRow = el('div', 'settings-row');
    const allTagsText = el('span', 'settings-row-text');
    allTagsText.append(textEl('span', ctx.t('settings.overviewAllTags'), 'settings-row-label'));
    allTagsText.append(
      textEl('span', ctx.t('settings.overviewAllTagsHint'), 'settings-row-meta muted'),
    );
    const allTagsSwitch = switchControl({
      checked: ctx.data().settings.overviewGroupByAllTags === true,
      label: ctx.t('settings.overviewAllTags'),
      onChange: (on) => {
        ctx.mutate((d) => {
          d.settings.overviewGroupByAllTags = on;
        });
      },
    });
    allTagsRow.append(allTagsText, allTagsSwitch.el);
    body.append(allTagsRow);
  }

  // Profile name: an optional free-text label (report header + export filename
  // prefill). Empty is fine — a localized default is shown wherever it surfaces.
  body.append(renderProfileNameRow(ctx));

  return card;
}

/**
 * Profile-name row: a label above a full-width text input. Stores the trimmed
 * value on change/blur; an empty string is stored as-is (never the localized
 * default literal), and the placeholder shows that default.
 */
function renderProfileNameRow(ctx: AppContext): HTMLElement {
  const row = el('div', 'settings-row settings-field');
  row.append(textEl('span', ctx.t('settings.profileName'), 'settings-field-label'));

  const input = document.createElement('input');
  input.type = 'text';
  input.value = ctx.data().profile.name ?? '';
  input.placeholder = ctx.t('profile.defaultName');
  input.setAttribute('aria-label', ctx.t('settings.profileName'));
  const commit = (): void => {
    ctx.mutate((d) => {
      d.profile.name = input.value.trim();
    });
  };
  input.addEventListener('change', commit);
  input.addEventListener('blur', commit);
  row.append(input);
  return row;
}

/**
 * Appearance row: an Auto / Light / Dark segmented control bound to
 * `settings.theme` (absent ⇒ 'auto'), mirroring the language/units controls.
 * The choice is persisted via `ctx.mutate` and applied immediately by swapping
 * the `data-theme` attribute on <html> — no view re-render is needed.
 */
type ThemePref = NonNullable<ProfileSettings['theme']>;

function renderAppearanceRow(ctx: AppContext): HTMLElement {
  const row = el('div', 'settings-row');
  row.append(textEl('span', ctx.t('settings.theme'), 'settings-row-label'));

  const current: ThemePref = ctx.data().settings.theme ?? 'auto';
  const seg = el('div', 'settings-segment');
  const options: { pref: ThemePref; labelKey: StringKey }[] = [
    { pref: 'auto', labelKey: 'settings.themeAuto' },
    { pref: 'light', labelKey: 'settings.themeLight' },
    { pref: 'dark', labelKey: 'settings.themeDark' },
  ];
  const buttons: { pref: ThemePref; el: HTMLButtonElement }[] = [];
  for (const { pref, labelKey } of options) {
    const b = button(ctx.t(labelKey), 'settings-segment-btn');
    if (current === pref) {
      b.classList.add('is-active');
      b.setAttribute('aria-current', 'true');
    }
    b.addEventListener('click', () => {
      if ((ctx.data().settings.theme ?? 'auto') === pref) return;
      ctx.mutate((d) => {
        d.settings.theme = pref;
      });
      animateThemeChange();
      applyTheme(pref);
      for (const other of buttons) {
        const active = other.pref === pref;
        other.el.classList.toggle('is-active', active);
        if (active) other.el.setAttribute('aria-current', 'true');
        else other.el.removeAttribute('aria-current');
      }
    });
    buttons.push({ pref, el: b });
    seg.append(b);
  }
  row.append(seg);
  return row;
}

/**
 * Units row: an Automatic / SI / US segmented control bound to
 * `settings.unitSystem` (absent ⇒ Automatic), mirroring the language control.
 * The choice is persisted via `ctx.mutate`; only the display-unit *selection*
 * changes (no conversion happens here). The active segment updates in place, and
 * every unit-aware view (overview, detail, compare, report, entry) re-resolves
 * its display unit the next time it renders — which the app does on navigation —
 * so there is no whole-view repaint from here.
 */
function renderUnitSystemRow(ctx: AppContext): HTMLElement {
  const row = el('div', 'settings-row');
  const text = el('span', 'settings-row-text');
  text.append(textEl('span', ctx.t('settings.units'), 'settings-row-label'));
  text.append(textEl('span', ctx.t('settings.unitSystemHint'), 'settings-row-meta muted'));
  row.append(text);

  const current: UnitSystem = ctx.data().settings.unitSystem ?? 'auto';
  const seg = el('div', 'settings-segment');
  const options: { system: UnitSystem; labelKey: StringKey }[] = [
    { system: 'auto', labelKey: 'settings.unitSystemAuto' },
    { system: 'si', labelKey: 'settings.unitSystemSi' },
    { system: 'us', labelKey: 'settings.unitSystemUs' },
  ];
  const buttons: { system: UnitSystem; el: HTMLButtonElement }[] = [];
  for (const { system, labelKey } of options) {
    const b = button(ctx.t(labelKey), 'settings-segment-btn');
    if (current === system) {
      b.classList.add('is-active');
      b.setAttribute('aria-current', 'true');
    }
    b.addEventListener('click', () => {
      if ((ctx.data().settings.unitSystem ?? 'auto') === system) return;
      ctx.mutate((d) => {
        d.settings.unitSystem = system;
      });
      // The change is invisible until the user leaves Settings, so confirm it.
      ctx.toast(ctx.t('settings.unitsChanged'), 'info');
      for (const other of buttons) {
        const active = other.system === system;
        other.el.classList.toggle('is-active', active);
        if (active) other.el.setAttribute('aria-current', 'true');
        else other.el.removeAttribute('aria-current');
      }
    });
    buttons.push({ system, el: b });
    seg.append(b);
  }
  row.append(seg);
  return row;
}

// ---------------------------------------------------------------------------
// Security: app password, auto-lock, lock now
// ---------------------------------------------------------------------------

function renderSecuritySection(ctx: AppContext): HTMLElement {
  const { t } = ctx;
  const { card, body } = groupCard('settings.security', t);

  // The encryption mode drives which rows are shown. It is resolved async from
  // the store; `refresh()` repaints only this card's body (never the whole
  // view) whenever the mode changes (password enabled / removed).
  function refresh(): void {
    void ctx.store.mode().then(
      (mode: EncryptionMode) => paint(mode),
      // Mode undetectable → treat as "no password yet": offer only to set one.
      () => paint('plaintext'),
    );
  }

  function paint(mode: EncryptionMode): void {
    body.replaceChildren();
    const actions = securityActions(mode);
    const on = !actions.enableEncryption; // encrypted ⇒ password is set

    const pwRow = navRow(
      t('settings.passwordApp'),
      on ? t('settings.passwordAppOn') : t('settings.passwordAppOff'),
    );
    pwRow.addEventListener('click', () => openPasswordDialog(ctx, mode, refresh));
    body.append(pwRow);

    // Auto-lock and manual lock only make sense for an encrypted profile — a
    // plaintext one never locks.
    if (actions.lockNow) {
      body.append(renderAutoLockRow(ctx));
      body.append(renderLockNowRow(ctx));
    }
  }

  refresh();
  return card;
}

function renderAutoLockRow(ctx: AppContext): HTMLElement {
  const { t } = ctx;
  const row = el('div', 'settings-row');
  row.append(textEl('span', t('settings.autoLock'), 'settings-row-label'));

  const select = document.createElement('select');
  select.className = 'settings-inline-select';
  select.setAttribute('aria-label', t('settings.autoLock'));
  const current = ctx.data().settings.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES;
  for (const opt of autoLockOptions()) {
    const label = opt.params ? t(opt.labelKey, opt.params) : t(opt.labelKey);
    select.add(new Option(label, String(opt.minutes), false, opt.minutes === current));
  }
  // Persisting the choice updates in-memory ProfileData only — no re-render.
  select.addEventListener('change', () => {
    const minutes = Number(select.value);
    ctx.mutate((d) => {
      d.settings.autoLockMinutes = minutes;
    });
  });
  row.append(select);
  return row;
}

function renderLockNowRow(ctx: AppContext): HTMLElement {
  // A plain action row (no chevron) so its accessible name is exactly the lock
  // label — the manual counterpart to the automatic inactivity/background lock.
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'settings-row settings-row-nav settings-row-action';
  b.append(textEl('span', ctx.t('lock.lockNow'), 'settings-row-label'));
  b.addEventListener('click', () => void ctx.lock());
  return b;
}

/**
 * Modal password manager. For an encrypted profile it offers "change" and
 * "remove"; otherwise it offers "set a password". A native `<dialog>` in the top
 * layer (appended to `document.body`) so a half-typed password survives any
 * re-render. On a change that flips the mode, `onChanged()` repaints the
 * security card.
 */
function openPasswordDialog(ctx: AppContext, mode: EncryptionMode, onChanged: () => void): void {
  const { t } = ctx;
  const dialog = document.createElement('dialog');
  dialog.className = 'modal';
  dialog.setAttribute('aria-label', t('settings.passwordApp'));
  dialog.addEventListener('close', () => dialog.remove());

  const box = el('div', 'modal-box');
  box.append(textEl('h3', t('settings.passwordApp')));

  const done = (): void => {
    dialog.close();
    onChanged();
  };

  const actions = securityActions(mode);
  if (actions.changePassphrase) box.append(buildChangePassphrase(ctx, done));
  if (actions.disableEncryption) box.append(buildDisableEncryption(ctx, done));
  if (actions.enableEncryption) box.append(buildEnableEncryption(ctx, done));

  const closeRow = el('div', 'settings-choice');
  const close = button(t('common.close'));
  close.addEventListener('click', () => dialog.close());
  closeRow.append(close);
  box.append(closeRow);

  dialog.append(box);
  document.body.append(dialog);
  dialog.showModal();
}

function buildChangePassphrase(ctx: AppContext, onSuccess: () => void): HTMLElement {
  const { t } = ctx;
  const box = el('div', 'settings-subsection');
  box.append(textEl('h3', t('settings.changePassphrase')));

  const cur = field(t('settings.currentPassphrase'));
  const curInput = passwordInput(t('settings.currentPassphrase'));
  cur.wrap.append(curInput);

  const next = field(t('settings.newPassphrase'));
  const nextInput = passwordInput(t('settings.newPassphrase'));
  next.wrap.append(nextInput);

  const repeat = field(t('onboarding.passphraseRepeat'));
  const repeatInput = passwordInput(t('onboarding.passphraseRepeat'));
  repeat.wrap.append(repeatInput);

  const error = inlineError();
  const submit = button(t('common.save'), 'primary');

  submit.addEventListener('click', () => {
    clearError(error);
    const issue = validateNewPassphrase(nextInput.value, repeatInput.value);
    if (issue === 'weak') return showError(error, t('onboarding.passphraseWeak'));
    if (issue === 'mismatch') return showError(error, t('onboarding.passphraseMismatch'));
    submit.disabled = true;
    void (async () => {
      try {
        await ctx.store.changePassphrase(curInput.value, nextInput.value);
        curInput.value = '';
        nextInput.value = '';
        repeatInput.value = '';
        ctx.toast(t('settings.passphraseChanged'), 'success');
        onSuccess();
      } catch (err) {
        // WrongPassphraseError is the expected failure (bad current passphrase).
        // No generic error key exists in the i18n table, so any other failure
        // reuses the same message rather than inventing/hardcoding one.
        const key: StringKey =
          err instanceof WrongPassphraseError ? 'lock.wrongPassphrase' : 'lock.wrongPassphrase';
        showError(error, t(key));
        submit.disabled = false;
      }
    })();
  });

  box.append(cur.wrap, next.wrap, repeat.wrap, error, submit);
  return box;
}

function buildEnableEncryption(ctx: AppContext, onSuccess: () => void): HTMLElement {
  const { t } = ctx;
  const box = el('div', 'settings-subsection');
  box.append(textEl('h3', t('settings.protectWithPassword')));
  box.append(textEl('p', t('settings.protectWithPasswordHint'), 'muted'));

  const next = field(t('settings.newPassphrase'));
  const nextInput = passwordInput(t('settings.newPassphrase'));
  next.wrap.append(nextInput);

  const repeat = field(t('onboarding.passphraseRepeat'));
  const repeatInput = passwordInput(t('onboarding.passphraseRepeat'));
  repeat.wrap.append(repeatInput);

  const error = inlineError();
  const submit = button(t('common.save'), 'primary');

  submit.addEventListener('click', () => {
    clearError(error);
    const issue = validateNewPassphrase(nextInput.value, repeatInput.value);
    if (issue === 'weak') return showError(error, t('onboarding.passphraseWeak'));
    if (issue === 'mismatch') return showError(error, t('onboarding.passphraseMismatch'));
    submit.disabled = true;
    void (async () => {
      try {
        await ctx.store.enableEncryption(nextInput.value);
        nextInput.value = '';
        repeatInput.value = '';
        ctx.toast(t('settings.passwordSet'), 'success');
        onSuccess();
      } catch {
        showError(error, t('onboarding.passphraseWeak'));
        submit.disabled = false;
      }
    })();
  });

  box.append(next.wrap, repeat.wrap, error, submit);
  return box;
}

function buildDisableEncryption(ctx: AppContext, onSuccess: () => void): HTMLElement {
  const { t } = ctx;
  const box = el('div', 'settings-subsection');
  box.append(textEl('h3', t('settings.removePassword')));

  const cur = field(t('settings.currentPassphrase'));
  const curInput = passwordInput(t('settings.currentPassphrase'));
  cur.wrap.append(curInput);

  const error = inlineError();
  const submit = button(t('common.save'), 'danger');

  submit.addEventListener('click', () => {
    clearError(error);
    submit.disabled = true;
    void (async () => {
      try {
        await ctx.store.disableEncryption(curInput.value);
        curInput.value = '';
        ctx.toast(t('settings.passwordRemoved'), 'success');
        onSuccess();
      } catch (err) {
        // WrongPassphraseError is the expected failure (bad current password);
        // no generic error key exists, so any other failure reuses it too.
        const key: StringKey =
          err instanceof WrongPassphraseError ? 'lock.wrongPassphrase' : 'lock.wrongPassphrase';
        showError(error, t(key));
        submit.disabled = false;
      }
    })();
  });

  box.append(cur.wrap, error, submit);
  return box;
}

// ---------------------------------------------------------------------------
// Measurement sources
// ---------------------------------------------------------------------------

function sourcesSummary(ctx: AppContext): string {
  return ctx.t('settings.sourcesSummary', { count: ctx.data().sources.length });
}

function renderSourcesSection(ctx: AppContext): HTMLElement {
  const { card, body } = groupCard('settings.sourcesGroup', ctx.t);

  const row = navRow(sourcesSummary(ctx));
  const labelSpan = row.querySelector('.settings-row-label') as HTMLElement;
  row.addEventListener('click', () =>
    openSourcesDialog(ctx, () => {
      // A source was added — refresh only the summary count in place.
      labelSpan.textContent = sourcesSummary(ctx);
    }),
  );
  body.append(row);
  return card;
}

/**
 * Modal sub-view listing the measurement sources with an inline add form. Adding
 * a source repaints only the dialog's own list (a targeted update, no view-wide
 * re-render) and calls `onChanged` so the summary row's count follows.
 */
function openSourcesDialog(ctx: AppContext, onChanged: () => void): void {
  const { t } = ctx;
  const dialog = document.createElement('dialog');
  dialog.className = 'modal';
  dialog.setAttribute('aria-label', t('settings.sourcesGroup'));
  dialog.addEventListener('close', () => dialog.remove());

  const box = el('div', 'modal-box');
  box.append(textEl('h3', t('settings.sourcesGroup')));

  // Live measurement count for a source — used to gate removal and to show the
  // "N measurements" meta on a source that can't be removed because it's in use.
  const usageCount = (src: Source): number =>
    ctx.data().measurements.filter((m) => m.sourceId === src.id).length;

  const list = el('ul', 'settings-list sources-list');

  function paintList(): void {
    list.replaceChildren();
    const sources = ctx.data().sources;
    if (sources.length === 0) {
      list.append(textEl('li', t('common.none'), 'settings-list-row muted'));
      return;
    }
    for (const src of sources) {
      list.append(renderRow(src));
    }
  }

  /** One source row. The built-in manual source is label-only (no chip/actions). */
  function renderRow(src: Source): HTMLElement {
    const li = el('li', 'settings-list-row sources-row');
    const builtIn = src.kind === 'manual';

    if (builtIn) {
      li.append(textEl('span', src.name, 'sources-name-text'));
      return li;
    }

    // Name — click (or the pencil) enters inline rename mode.
    const nameBtn = button(src.name, 'sources-name');
    nameBtn.setAttribute('aria-label', `${t('common.edit')} — ${src.name}`);
    nameBtn.addEventListener('click', () => startRename(li, src));
    li.append(nameBtn);

    const side = el('span', 'sources-row-side');
    side.append(
      textEl('span', t(`source.kind.${src.kind}` as StringKey), 'tag-chip tag-chip--mini'),
    );

    const count = usageCount(src);
    if (count > 0) {
      // Used → no remove; a muted meta explaining why (and how many). Its title
      // points at the timeline bulk action, the way to move those measurements
      // off this source so it can then be removed.
      const meta = textEl('span', t('settings.sourceInUse', { count }), 'sources-row-meta muted');
      meta.title = t('settings.sourceInUseHint');
      side.append(meta);
    } else {
      const remove = button('×', 'sources-remove');
      remove.setAttribute('aria-label', t('common.remove'));
      remove.addEventListener('click', () => startRemove(li, src));
      side.append(remove);
    }
    li.append(side);
    return li;
  }

  /** Swap a row into an inline name editor (Enter/✓ commit, Escape cancel). */
  function startRename(li: HTMLElement, src: Source): void {
    li.replaceChildren();
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'sources-name-input';
    input.value = src.name;
    input.setAttribute('aria-label', t('settings.sourceName'));

    const error = inlineError();
    const confirm = button('✓', 'metric-chip-confirm');
    confirm.setAttribute('aria-label', t('common.save'));

    const commit = (): void => {
      const trimmed = input.value.trim();
      if (!trimmed) {
        input.focus();
        return;
      }
      if (sourceNameExists(ctx.data().sources, trimmed, src.id)) {
        showError(error, t('settings.sourceDuplicate'));
        input.focus();
        return;
      }
      ctx.mutate((d) => {
        const s = d.sources.find((x) => x.id === src.id);
        if (s) s.name = trimmed;
      });
      paintList();
      onChanged();
    };
    confirm.addEventListener('click', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        paintList();
      }
    });

    const editRow = el('span', 'sources-row-edit');
    editRow.append(input, confirm);
    li.append(editRow, error);
    input.focus();
    input.select();
  }

  /** Inline two-step remove confirm within the row (no native confirm). */
  function startRemove(li: HTMLElement, src: Source): void {
    li.replaceChildren();
    li.append(textEl('span', t('settings.sourceRemoveConfirm'), 'sources-remove-text'));

    const actions = el('span', 'sources-row-side');
    const cancel = button(t('common.cancel'), 'sources-confirm-cancel');
    cancel.addEventListener('click', () => paintList());
    const confirm = button(t('common.confirm'), 'danger');
    confirm.addEventListener('click', () => {
      ctx.mutate((d) => {
        d.sources = d.sources.filter((s) => s.id !== src.id);
      });
      paintList();
      onChanged();
    });
    actions.append(cancel, confirm);
    li.append(actions);
  }

  paintList();
  box.append(list);
  box.append(el('div', 'sources-dialog-sep'));

  // Add-source form: Name + Type + Add on one row (stacks on a narrow dialog).
  const form = el('div', 'settings-inline-form sources-add-form');
  const nameField = field(t('settings.sourceName'));
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'sources-name-field';
  nameInput.setAttribute('aria-label', t('settings.sourceName'));
  nameField.wrap.append(nameInput);

  const kindField = field(t('settings.sourceKind'));
  const kindSelect = document.createElement('select');
  kindSelect.className = 'settings-inline-select';
  kindSelect.setAttribute('aria-label', t('settings.sourceKind'));
  for (const opt of sourceKindOptions()) {
    kindSelect.add(new Option(t(opt.labelKey), opt.kind));
  }
  kindField.wrap.append(kindSelect);

  const addError = inlineError();
  const add = button(t('settings.addSource'), 'primary');
  const submitAdd = (): void => {
    clearError(addError);
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    if (sourceNameExists(ctx.data().sources, name)) {
      showError(addError, t('settings.sourceDuplicate'));
      nameInput.focus();
      return;
    }
    const created = buildSource(ctx.data().sources, name, kindSelect.value as SourceKind);
    if (!created) return;
    ctx.mutate((d) => {
      d.sources.push(created);
    });
    nameInput.value = '';
    paintList();
    onChanged();
    nameInput.focus();
  };
  add.addEventListener('click', submitAdd);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitAdd();
    }
  });

  form.append(nameField.wrap, kindField.wrap, add);
  box.append(form, addError);
  box.append(el('div', 'sources-dialog-sep'));

  const closeRow = el('div', 'settings-choice sources-footer');
  const close = button(t('common.close'));
  close.addEventListener('click', () => dialog.close());
  closeRow.append(close);
  box.append(closeRow);

  dialog.append(box);
  document.body.append(dialog);
  dialog.showModal();
}

// ---------------------------------------------------------------------------
// Backup export
// ---------------------------------------------------------------------------

function renderBackupSection(ctx: AppContext): HTMLElement {
  const { t } = ctx;
  const { card, body } = groupCard('settings.backup', t);

  // The optional backup password is asked for at export time in a modal (never
  // stored or shown as a standing field). The Záloha card is now backup-only:
  // interop formats (CSV, FHIR, printable report) live behind the Export wizard.
  const actions = el('div', 'settings-backup-actions');
  const jsonBtn = button(t('settings.exportJson'), 'primary');
  jsonBtn.addEventListener('click', () => renderExportPasswordPrompt(ctx));
  actions.append(jsonBtn);

  body.append(actions, textEl('p', t('settings.backupNote'), 'muted settings-note'));
  return card;
}


async function runExport(ctx: AppContext, kind: ExportKind, password?: string): Promise<void> {
  const plugin = exportPluginById(kind);
  if (!plugin) return;
  const exportCtx: ExportContext = {
    data: ctx.data(),
    catalog: ctx.catalog(),
    units: ctx.units,
    locale: ctx.locale,
  };
  // A non-empty password (json-backup only) yields an encrypted backup file.
  const selection: ExportSelection = password ? { password } : {};
  const blob = await plugin.export(selection, exportCtx);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = buildExportFilename(kind, profileDisplayName(ctx.data().profile.name, ctx.t));
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Modal prompt asking (at export time) for an optional password to encrypt the
 * JSON backup — like a certificate. The password is never stored or kept as a
 * standing field. Leaving both fields empty produces a plain backup; a non-empty
 * password must be confirmed in a second field (a typo would make the backup
 * unrecoverable) and meet the minimum length.
 */
function renderExportPasswordPrompt(ctx: AppContext): void {
  const { t } = ctx;
  const dialog = document.createElement('dialog');
  dialog.className = 'modal';
  dialog.setAttribute('aria-label', t('settings.exportJson'));
  dialog.addEventListener('close', () => dialog.remove());

  const box = el('div', 'modal-box');
  box.append(textEl('h3', t('settings.exportJson')));
  box.append(textEl('p', t('backup.passwordHint'), 'muted'));

  const pw = field(t('backup.password'));
  const pwInput = passwordInput(t('backup.password'));
  pw.wrap.append(pwInput);

  const rep = field(t('onboarding.passphraseRepeat'));
  const repInput = passwordInput(t('onboarding.passphraseRepeat'));
  rep.wrap.append(repInput);

  const error = inlineError();
  const row = el('div', 'settings-choice');
  const cancel = button(t('common.cancel'));
  cancel.addEventListener('click', () => dialog.close());
  const confirm = button(t('settings.export'), 'primary');

  const submit = (): void => {
    clearError(error);
    const password = pwInput.value;
    if (password === '') {
      // No password → plain backup.
      dialog.close();
      void runExport(ctx, 'json-backup');
      return;
    }
    const issue = validateNewPassphrase(password, repInput.value);
    if (issue) {
      showError(
        error,
        t(issue === 'mismatch' ? 'onboarding.passphraseMismatch' : 'onboarding.passphraseWeak'),
      );
      return;
    }
    dialog.close();
    void runExport(ctx, 'json-backup', password);
  };
  confirm.addEventListener('click', submit);
  repInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });

  row.append(cancel, confirm);
  box.append(pw.wrap, rep.wrap, error, row);
  dialog.append(box);
  document.body.append(dialog);
  dialog.showModal();
  pwInput.focus();
}

// ---------------------------------------------------------------------------
// Danger zone: delete all data
// ---------------------------------------------------------------------------

function renderDangerSection(ctx: AppContext): HTMLElement {
  const { card, body } = groupCard('settings.dangerZone', ctx.t);
  card.classList.add('settings-danger-card');
  const wipeHost = el('div');
  renderWipeIdle(ctx, wipeHost);
  body.append(wipeHost);
  return card;
}

function renderWipeIdle(ctx: AppContext, host: HTMLElement): void {
  host.replaceChildren();
  const btn = button(`${ctx.t('settings.wipe')}…`, 'settings-wipe-btn');
  btn.addEventListener('click', () => renderWipeConfirm(ctx, host, 1));
  host.append(btn);
}

function renderWipeConfirm(ctx: AppContext, host: HTMLElement, step: 1 | 2): void {
  const { t } = ctx;
  host.replaceChildren();
  const messageKey: StringKey = step === 1 ? 'settings.wipeConfirm' : 'settings.wipeConfirmAgain';
  host.append(textEl('p', t(messageKey), 'settings-danger-text'));
  // A wipe is a factory reset: it also clears every activated pack (back to just
  // the always-on seed). State the scope plainly — no option, no checkbox.
  host.append(textEl('p', t('settings.wipeIncludesPacks'), 'settings-danger-text muted'));

  // On the final step of an encrypted profile, re-authentication is required:
  // wiping is irreversible, so a set password must be re-entered before it runs.
  // The field is populated asynchronously once the store confirms the mode; a
  // plaintext profile keeps the plain two-step confirm (no passphrase to ask).
  let passInput: HTMLInputElement | undefined;
  const error = inlineError();
  if (step === 2) {
    void ctx.store.mode().then((mode) => {
      if (mode !== 'encrypted') return;
      const pw = field(t('settings.wipePassword'));
      passInput = passwordInput(t('settings.wipePassword'));
      pw.wrap.append(passInput);
      host.insertBefore(pw.wrap, error);
      passInput.focus();
    }, () => {});
  }
  host.append(error);

  const row = el('div', 'settings-choice');
  const cancel = button(t('common.cancel'));
  cancel.addEventListener('click', () => renderWipeIdle(ctx, host));
  const confirm = button(t('common.confirm'), 'danger');
  confirm.addEventListener('click', () => {
    if (step === 1) {
      renderWipeConfirm(ctx, host, 2);
      return;
    }
    clearError(error);
    confirm.disabled = true;
    cancel.disabled = true;
    if (passInput) passInput.disabled = true;
    void (async () => {
      // verifyPassphrase returns true for plaintext profiles regardless of input.
      const ok = await ctx.store.verifyPassphrase(passInput?.value ?? '');
      if (!ok) {
        showError(error, t('settings.wipeWrongPassword'));
        confirm.disabled = false;
        cancel.disabled = false;
        if (passInput) {
          passInput.disabled = false;
          passInput.focus();
        }
        return;
      }
      await ctx.store.wipe();
      // Back to onboarding: the shell re-runs its boot flow on reload.
      location.reload();
    })();
  });
  row.append(cancel, confirm);
  host.append(row);
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function renderFooter(ctx: AppContext): HTMLElement {
  const { t } = ctx;
  const foot = el('div', 'settings-footer');
  const line = `${t('settings.version')} ${appVersion()} · ${LICENSE} · ${t('settings.footerPrivacy')}`;
  foot.append(textEl('p', line, 'muted'));

  // Link to the project's official website. A user-initiated navigation (opens in
  // a new tab) — not a runtime network request, so it keeps the offline-first
  // promise. No query params: nothing about the user leaves the device.
  const siteRow = el('p', 'muted settings-site');
  const siteLink = document.createElement('a');
  siteLink.href = 'https://vitametr.com';
  siteLink.target = '_blank';
  siteLink.rel = 'noopener noreferrer';
  siteLink.textContent = t('settings.projectSite');
  siteRow.append(siteLink);
  foot.append(siteRow);

  foot.append(textEl('p', LOINC_ATTRIBUTION, 'muted settings-attribution'));
  return foot;
}

// ---------------------------------------------------------------------------
// View entry point
// ---------------------------------------------------------------------------

export const settingsView: View = {
  render(container, ctx) {
    container.replaceChildren();
    const root = el('div', 'settings-view');
    root.append(textEl('h1', ctx.t('settings.title')));
    root.append(
      renderTrustBanner(ctx),
      renderLanguageSection(ctx),
      renderSecuritySection(ctx),
      renderSourcesSection(ctx),
      renderBackupSection(ctx),
      renderDangerSection(ctx),
      renderFooter(ctx),
    );
    container.append(root);
  },
};
