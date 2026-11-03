import { beforeEach, describe, expect, it, vi } from 'vitest';
const config = vi.hoisted(() => ({ telegramApiId: null as number | null, telegramApiHash: null as string | null, telegramSessionString: null as string | null }));
vi.mock('../../src/config/index.js', () => ({ config }));
import { sourceCapabilities } from '../../src/server/routes/source-capabilities.js';

describe('source configuration evidence', () => {
    beforeEach(() => { vi.stubEnv('TWITTER_BEARER_TOKEN', ''); config.telegramApiId = null; config.telegramApiHash = null; config.telegramSessionString = null; });
    it('does not require an X API key for scrape mode', () => {
        const result = sourceCapabilities(true);
        expect(result.providers.TWITTER.ready).toBe(true);
        expect(result.providers.TWITTER_API.ready).toBe(false);
        expect(result.providers.TELEGRAM.ready).toBe(false);
    });
    it('reports dependency failure and never returns configured credential values', () => {
        config.telegramApiId = 123; config.telegramApiHash = 'fixture-hash'; config.telegramSessionString = 'fixture-session';
        vi.stubEnv('TWITTER_BEARER_TOKEN', 'fixture-token');
        const result = sourceCapabilities(false);
        expect(result.providers.TWITTER.ready).toBe(false);
        expect(result.providers.TELEGRAM.ready).toBe(true);
        expect(JSON.stringify(result)).not.toMatch(/fixture-(hash|session|token)/);
    });
});
