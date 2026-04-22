import { describe, it, expect } from 'vitest';

function applyConfiguredMax<T>(
    items: T[],
    configuredMaxResults: number | undefined,
    fetchedSoFar: number
): T[] {
    const remainingAllowed =
        typeof configuredMaxResults === 'number' && configuredMaxResults > 0
            ? Math.max(configuredMaxResults - fetchedSoFar, 0)
            : undefined;

    return typeof remainingAllowed === 'number'
        ? items.slice(0, remainingAllowed)
        : items;
}

describe('fetch worker max_results enforcement', () => {
    it('caps first page to configured max_results', () => {
        const items = Array.from({ length: 20 }, (_, i) => i);
        const accepted = applyConfiguredMax(items, 9, 0);

        expect(accepted).toHaveLength(9);
    });

    it('caps continuation page by remaining allowance', () => {
        const items = Array.from({ length: 20 }, (_, i) => i);
        const accepted = applyConfiguredMax(items, 9, 7);

        expect(accepted).toHaveLength(2);
    });

    it('accepts no items after limit reached', () => {
        const items = Array.from({ length: 5 }, (_, i) => i);
        const accepted = applyConfiguredMax(items, 9, 9);

        expect(accepted).toHaveLength(0);
    });
});
