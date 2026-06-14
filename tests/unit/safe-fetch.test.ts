import { describe, it, expect, vi } from 'vitest';

// Mock the rate limiter so importing safe-fetch doesn't pull in config/redis.
vi.mock('../../src/services/rate-limiter.js', () => ({
    rateLimiter: {
        consumeRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 1, resetMs: 0 }),
    },
}));

import { assertPublicUrl, SSRFError } from '../../src/utils/safe-fetch.js';

describe('assertPublicUrl (SSRF guard)', () => {
    it('rejects loopback', async () => {
        await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toBeInstanceOf(SSRFError);
    });

    it('rejects cloud metadata IP', async () => {
        await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(SSRFError);
    });

    it('rejects private 10/8', async () => {
        await expect(assertPublicUrl('http://10.0.0.5/')).rejects.toBeInstanceOf(SSRFError);
    });

    it('rejects private 192.168/16', async () => {
        await expect(assertPublicUrl('http://192.168.1.1/')).rejects.toBeInstanceOf(SSRFError);
    });

    it('rejects CGNAT 100.64/10', async () => {
        await expect(assertPublicUrl('http://100.64.0.1/')).rejects.toBeInstanceOf(SSRFError);
    });

    it('rejects IPv6 loopback', async () => {
        await expect(assertPublicUrl('http://[::1]/')).rejects.toBeInstanceOf(SSRFError);
    });

    it('rejects non-http(s) schemes', async () => {
        await expect(assertPublicUrl('file:///etc/passwd')).rejects.toBeInstanceOf(SSRFError);
    });

    it('allows a public IP literal', async () => {
        await expect(assertPublicUrl('https://1.1.1.1/')).resolves.toBeUndefined();
    });
});
