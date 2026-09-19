import { describe, expect, it } from 'vitest';
import { persistedChapterPlan } from '../../src/workers/atomization.helpers.js';

const applied = [{ title: 'معنى الفصل', start_ms: 0, end_ms: 1700000 }, { title: 'سياق آخر', start_ms: 1700000, end_ms: 3000000 }];
describe('CMS applied chapter plan contract', () => {
  it('consumes the exact applied object without equalizing boundaries or changing titles', () => {
    const result = persistedChapterPlan({ generation: null, applied_plan: applied });
    expect(result?.plan).toBe(applied);
    expect(result?.origin).toBe('manual');
    expect(result?.plan[0].end_ms).toBe(1700000);
  });
  it('resumes its frozen plan even if a newer draft exists', () => {
    const frozen = [{ title: 'Frozen plan', start_ms: 0, end_ms: 1500000 }];
    expect(persistedChapterPlan({ generation: { plan: frozen }, applied_plan: applied })?.plan).toBe(frozen);
  });
  it('never silently falls back when frozen or applied evidence is empty', () => {
    expect(() => persistedChapterPlan({ generation: {}, applied_plan: applied })).toThrow('reconciliation');
    expect(() => persistedChapterPlan({ generation: null, applied_plan: [] })).toThrow('reconciliation');
  });
  it('allows ordinary automatic planning only without a frozen or applied plan', () => {
    expect(persistedChapterPlan({ generation: null })).toBeNull();
  });
});
