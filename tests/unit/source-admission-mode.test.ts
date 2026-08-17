import { describe, expect, it } from 'vitest';

import { sourceAdmissionMode } from '../../src/services/source-admission-mode.js';

describe('sourceAdmissionMode', () => {
	it('keeps an older CMS response on the compatibility producer', () => {
		expect(sourceAdmissionMode({})).toBe('compatibility');
	});

	it('honors the explicit lane owner from CMS', () => {
		expect(sourceAdmissionMode({ source_run_admission_mode: 'compatibility' })).toBe('compatibility');
		expect(sourceAdmissionMode({ source_run_admission_mode: 'durable' })).toBe('durable');
	});
});
