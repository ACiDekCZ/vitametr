import { describe, expect, it } from 'vitest';

import * as core from '../index.js';

describe('core scaffold', () => {
    it('exposes the core module', () => {
        expect(core).toBeDefined();
        expect(typeof core).toBe('object');
    });
});
