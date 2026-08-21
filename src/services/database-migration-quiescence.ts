import { getAllWorkers } from '../workers/index.js';
import { getQueue, QUEUE_NAMES } from '../queues/index.js';
import { getRedisConnection } from '../queues/redis.js';

let owner: { programId: string; epoch: number; since: string } | null = null;
const OWNER_KEY = 'wahb:database-migration:aggregation-quiesced';

async function durableOwner() {
  const raw = await getRedisConnection().get(OWNER_KEY);
  if (!raw) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !('programId' in parsed) || !('epoch' in parsed) || !('since' in parsed)) throw new Error('invalid durable migration owner state');
  const candidate = parsed as { programId: unknown; epoch: unknown; since: unknown };
  if (typeof candidate.programId !== 'string' || typeof candidate.epoch !== 'number' || typeof candidate.since !== 'string') throw new Error('invalid durable migration owner state');
  return { programId: candidate.programId, epoch: candidate.epoch, since: candidate.since };
}

async function restoreDurableOwner() {
  const persisted = await durableOwner();
  if (!persisted) return null;
  owner = persisted;
  await Promise.all(getAllWorkers().map(worker => worker.pause(true)));
  return persisted;
}

export async function quiesceForDatabaseMigration(programId: string, epoch: number) {
	await restoreDurableOwner();
  if (owner && (owner.programId !== programId || owner.epoch !== epoch)) throw new Error('migration owner belongs to another program or epoch');
  owner ??= { programId, epoch, since: new Date().toISOString() };
	await getRedisConnection().set(OWNER_KEY, JSON.stringify(owner));
  await Promise.all(getAllWorkers().map(worker => worker.pause(true)));
  return databaseMigrationQuiescence();
}

export async function resumeAfterDatabaseMigration(programId: string, epoch: number) {
	await restoreDurableOwner();
  if (!owner || owner.programId !== programId || owner.epoch !== epoch) throw new Error('migration owner does not match program and epoch');
  await Promise.all(getAllWorkers().map(worker => worker.resume()));
	await getRedisConnection().del(OWNER_KEY);
  owner = null;
  return databaseMigrationQuiescence();
}

export async function databaseMigrationQuiescence() {
	try {
		await restoreDurableOwner();
	} catch {
		return { state: 'unknown', owner: null, active_count: 0, queues: [], worker_count: getAllWorkers().length, observed_at: new Date().toISOString() };
	}
  let active = 0;
  const queues: Array<{ queue: string; active: number; state: 'present'|'absent'|'unknown' }> = [];
  for (const name of Object.values(QUEUE_NAMES)) {
    const queue = getQueue(name);
    if (!queue) continue;
    try { const count = await queue.getActiveCount(); active += count; queues.push({ queue: name, active: count, state: count > 0 ? 'present' : 'absent' }); }
    catch { queues.push({ queue: name, active: 0, state: 'unknown' }); }
  }
  const unknown = queues.some(queue => queue.state === 'unknown');
  return { state: unknown ? 'unknown' : !owner ? 'not_quiesced' : active === 0 ? 'quiesced' : 'draining', owner, active_count: active, queues, worker_count: getAllWorkers().length, observed_at: new Date().toISOString() };
}
