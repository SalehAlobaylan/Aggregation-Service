import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildEmbeddingText } from '../../src/ai/embeddings.js';

describe('canonical embedding input', () => {
  it('matches the CMS lifecycle builder for shared Arabic/media fixtures', () => {
    const fixtures = JSON.parse(readFileSync(new URL('../../../Content-Management-System/testdata/embedding-input.json', import.meta.url), 'utf8'));
    for (const row of fixtures) expect(buildEmbeddingText(row.title, row.excerpt, row.body, row.transcript)).toBe(row.expected);
  });
  it('caps transcript and body without splitting Unicode characters', () => {
    const text = buildEmbeddingText('😀', undefined, 'ح'.repeat(10_000), 'ن'.repeat(10_000));
    expect(Array.from(text).length).toBeLessThanOrEqual(8192);
    expect(text.startsWith(`😀 ${'ن'.repeat(3000)} `)).toBe(true);
  });
});
