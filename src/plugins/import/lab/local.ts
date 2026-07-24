/**
 * Local-only lab parsers extension point.
 *
 * Committed EMPTY. A private parser (e.g. one clinic's PDF export you don't want
 * in the public repo) can be added WITHOUT committing it:
 *   1. put the parser in this folder, e.g. `./praktik.ts`, and add that file to
 *      `.git/info/exclude`;
 *   2. import + list it here;
 *   3. `git update-index --skip-worktree src/plugins/import/lab/local.ts` so
 *      your edit to this file is never staged.
 *
 * `parseLabDocument` tries these before the generic parser. See PLUGINS.md.
 */

import type { LabParser } from '../lab-parsers';

export const LOCAL_LAB_PARSERS: readonly LabParser[] = [];
