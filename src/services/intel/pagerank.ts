/**
 * Personalized PageRank over the source citation graph — authority "in your
 * trusted neighborhood". Restart (teleport) mass goes to the SEED set (your
 * approved sources), so domains your trusted sources point to score high, and
 * the rest of the web fades. Pure power-method; no deps.
 */
export interface GraphEdge {
    from: string;
    to: string;
    weight: number;
}

export function personalizedPageRank(
    edges: GraphEdge[],
    seeds: string[],
    opts: { damping?: number; iterations?: number } = {}
): Map<string, number> {
    const damping = opts.damping ?? 0.85;
    const iterations = opts.iterations ?? 25;

    const nodes = new Set<string>();
    for (const e of edges) {
        nodes.add(e.from);
        nodes.add(e.to);
    }
    for (const s of seeds) nodes.add(s);
    const nodeList = [...nodes];
    const n = nodeList.length;
    if (n === 0) return new Map();

    const outW = new Map<string, number>();
    const adj = new Map<string, { to: string; w: number }[]>();
    for (const e of edges) {
        outW.set(e.from, (outW.get(e.from) ?? 0) + e.weight);
        const arr = adj.get(e.from) ?? [];
        arr.push({ to: e.to, w: e.weight });
        adj.set(e.from, arr);
    }

    const seedSet = new Set(seeds.length ? seeds : nodeList);
    const restart = 1 / seedSet.size;

    let rank = new Map<string, number>();
    for (const node of nodeList) rank.set(node, 1 / n);

    for (let it = 0; it < iterations; it++) {
        const next = new Map<string, number>();
        for (const node of nodeList) next.set(node, 0);

        // Teleport mass to seeds.
        for (const s of seedSet) next.set(s, (next.get(s) ?? 0) + (1 - damping) * restart);

        let dangling = 0;
        for (const node of nodeList) {
            const r = rank.get(node) ?? 0;
            const ow = outW.get(node) ?? 0;
            if (ow === 0) {
                dangling += r;
                continue;
            }
            for (const { to, w } of adj.get(node)!) {
                next.set(to, (next.get(to) ?? 0) + damping * r * (w / ow));
            }
        }
        // Dangling mass redistributes to the seed set (personalized).
        for (const s of seedSet) next.set(s, (next.get(s) ?? 0) + (damping * dangling) * restart);

        rank = next;
    }

    // Normalize to 0..1 by the max (authority is comparative, not absolute).
    let max = 0;
    for (const v of rank.values()) if (v > max) max = v;
    if (max > 0) for (const [k, v] of rank) rank.set(k, v / max);
    return rank;
}
