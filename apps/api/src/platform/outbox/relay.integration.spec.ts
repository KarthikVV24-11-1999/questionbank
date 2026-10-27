import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KEY_BEARING_FIELDS } from '../../fitness/content-rules.js';
import { MISCONCEPTION_TEXT, SOLUTION_TEXT, itemContent, publishItem } from '../../testing/content-publishing.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { OutboxRelay, PermanentDeliveryFailure, type OutboxConsumer, type OutboxEnvelope, type RelayPolicy } from './relay.js';

/**
 * The relay against the real outbox (M6-38, closes D17). Time is passed in, never waited for: a lease that runs out, a back-off
 * that elapses and a retry that comes due are each a later `now`.
 */
let database: TestDatabase;
const T0 = new Date('2026-10-23T10:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

const POLICY: RelayPolicy = { batchSize: 25, leaseMs: 60_000, maxAttempts: 3, retryBaseMs: 1_000, retryMaxMs: 8_000, maxRounds: 10 };

let order = 0;
async function seed(
  pool: Pool,
  overrides: { eventType?: string; aggregateId?: string; payload?: Record<string, unknown>; occurredAt?: Date } = {},
): Promise<string> {
  order += 1;
  const { rows } = await pool.query<{ outbox_message_id: string }>(
    `INSERT INTO platform.outbox_message
       (event_type, schema_version, aggregate_type, aggregate_id, payload, principal_kind, principal_id, correlation_id, occurred_at)
     VALUES ($1, 1, 'Thing', $2, $3, 'system', $4, 'corr', $5) RETURNING outbox_message_id`,
    [overrides.eventType ?? 'ThingHappened', overrides.aggregateId ?? randomUUID(), JSON.stringify(overrides.payload ?? { n: order }), randomUUID(), overrides.occurredAt ?? later(order)],
  );
  return rows[0]!.outbox_message_id;
}

class Recorder implements OutboxConsumer {
  readonly seen: OutboxEnvelope[] = [];
  readonly effects = new Set<string>();
  failWhile: (envelope: OutboxEnvelope) => boolean = () => false;
  constructor(readonly name = 'recorder') {}
  async handle(envelope: OutboxEnvelope): Promise<void> {
    this.seen.push(envelope);
    if (this.failWhile(envelope)) throw new Error(`refused ${envelope.messageId}`);
    this.effects.add(envelope.messageId); // idempotent by construction: the effect is a set member
  }
}

const relayFor = (consumer: OutboxConsumer, policy: RelayPolicy = POLICY, eventTypes = ['ThingHappened']) =>
  new OutboxRelay(database.pool, new Map(eventTypes.map((type) => [type, [consumer]])), policy);

const state = async (id: string) =>
  (await database.pool.query('SELECT published_at, dead_at, attempts, claimed_until, retry_at, last_error FROM platform.outbox_message WHERE outbox_message_id = $1', [id])).rows[0];

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
});

beforeEach(async () => {
  order = 0;
  await database.pool.query('ALTER TABLE platform.outbox_message DISABLE TRIGGER outbox_message_event_immutable');
  await database.pool.query('DELETE FROM platform.outbox_message');
  await database.pool.query('ALTER TABLE platform.outbox_message ENABLE TRIGGER outbox_message_event_immutable');
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

describe('delivery', () => {
  it('hands a message to its consumer, marks it published, and finds nothing the next time', async () => {
    const id = await seed(database.pool);
    const consumer = new Recorder();
    const relay = relayFor(consumer);
    expect(await relay.drain(T0)).toEqual({ claimed: 1, delivered: 1, retried: 0, deadLettered: 0, refused: 0 });
    expect(consumer.seen).toHaveLength(1);
    expect(consumer.seen[0]).toMatchObject({ messageId: id, eventType: 'ThingHappened', attempt: 1, aggregateType: 'Thing', correlationId: 'corr', principal: { kind: 'system' } });
    expect((await state(id)).published_at).not.toBeNull();
    expect(await relay.drain(later(1_000))).toEqual({ claimed: 0, delivered: 0, retried: 0, deadLettered: 0, refused: 0 });
    expect(consumer.seen).toHaveLength(1);
  });

  it('hands the envelope frozen, with the payload as written and no field the relay added', async () => {
    await seed(database.pool, { payload: { a: 1, b: ['x'] } });
    const consumer = new Recorder();
    await relayFor(consumer).drain(T0);
    const envelope = consumer.seen[0]!;
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.payload)).toBe(true);
    expect(envelope.payload).toEqual({ a: 1, b: ['x'] });
  });

  it('leaves alone an event type no consumer is registered for, so a consumer that arrives later drains its history', async () => {
    const stray = await seed(database.pool, { eventType: 'SomebodyElsesEvent' });
    const mine = await seed(database.pool);
    const consumer = new Recorder();
    await relayFor(consumer).drain(T0);
    expect((await state(mine)).published_at).not.toBeNull();
    expect(await state(stray)).toMatchObject({ published_at: null, dead_at: null, attempts: 0, claimed_until: null });
    const late = new Recorder('late');
    await relayFor(late, POLICY, ['SomebodyElsesEvent']).drain(later(10));
    expect(late.seen.map((e) => e.messageId)).toEqual([stray]);
  });

  it('does nothing, and says so, with no consumers at all', async () => {
    await seed(database.pool);
    expect(await new OutboxRelay(database.pool, new Map(), POLICY).drain(T0)).toMatchObject({ claimed: 0 });
  });
});

describe('at least once — a consumer that throws leaves the message claimable again', () => {
  it('retries after a back-off that doubles, records the error without the payload, and delivers when the consumer recovers', async () => {
    const id = await seed(database.pool, { payload: { n: 1 } });
    const consumer = new Recorder();
    consumer.failWhile = (envelope) => envelope.attempt < 3;
    const relay = relayFor(consumer);

    expect(await relay.drain(T0)).toMatchObject({ claimed: 1, delivered: 0, retried: 1 });
    const failed = await state(id);
    expect(failed.published_at).toBeNull();
    expect(failed.dead_at).toBeNull();
    expect(failed.claimed_until).toBeNull();
    expect(failed.last_error).toContain('refused');
    expect(failed.last_error).not.toContain('"n"');
    expect(new Date(failed.retry_at).getTime() - T0.getTime()).toBe(1_000);

    // not before the back-off
    expect(await relay.drain(later(999))).toMatchObject({ claimed: 0 });
    // at it: the second failure waits twice as long
    expect(await relay.drain(later(1_000))).toMatchObject({ retried: 1 });
    expect(new Date((await state(id)).retry_at).getTime() - later(1_000).getTime()).toBe(2_000);
    // and the third delivery succeeds
    expect(await relay.drain(later(3_000))).toMatchObject({ delivered: 1 });
    expect(consumer.seen.map((e) => e.attempt)).toEqual([1, 2, 3]);
    expect(consumer.effects.size).toBe(1);
    expect((await state(id)).published_at).not.toBeNull();
    expect((await state(id)).last_error).toBeNull();
  });

  it('caps the back-off', async () => {
    const id = await seed(database.pool);
    const consumer = new Recorder();
    consumer.failWhile = () => true;
    const relay = relayFor(consumer, { ...POLICY, maxAttempts: 10, retryBaseMs: 5_000, retryMaxMs: 8_000 });
    await relay.drain(T0);
    await relay.drain(later(5_000));
    expect(new Date((await state(id)).retry_at).getTime() - later(5_000).getTime()).toBe(8_000);
  });
});

describe('messages that occurred at the same instant', () => {
  it('are delivered in a fixed order, by id, so a drain is the same every time', async () => {
    const same = later(5);
    const ids = [await seed(database.pool, { occurredAt: same }), await seed(database.pool, { occurredAt: same }), await seed(database.pool, { occurredAt: same })];
    const consumer = new Recorder();
    await relayFor(consumer).drain(T0);
    expect(consumer.seen.map((e) => e.messageId)).toEqual([...ids].sort());
  });
});

describe('what a failing consumer leaves behind', () => {
  it('records something that is not an Error as text, and truncates a long one', async () => {
    const id = await seed(database.pool);
    const thrower: OutboxConsumer = { name: 'thrower', handle: async () => { throw 'x'.repeat(2_000); } };
    await relayFor(thrower).drain(T0);
    const row = await state(id);
    expect(row.last_error).toBe('x'.repeat(500));
  });
});

describe('the consumer\'s job — a relay that dies after the effect and before the acknowledgement delivers again', () => {
  /** A pool whose acknowledgement (the update that marks a message published) fails once, as a process dying at that moment would. */
  function dyingBeforeAcknowledgement(): { pool: Pool; revive: () => void } {
    let dying = true;
    const real = database.pool;
    const pool = new Proxy(real, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === 'query' && typeof value === 'function') {
          return (sql: unknown, ...rest: unknown[]) => {
            if (dying && typeof sql === 'string' && sql.includes('SET published_at')) {
              dying = false;
              return Promise.reject(new Error('the relay died before it could acknowledge'));
            }
            return (value as (...a: unknown[]) => unknown).apply(target, [sql, ...rest]);
          };
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as Pool;
    return { pool, revive: () => (dying = false) };
  }

  it('is redelivered once the lease runs out; an idempotent consumer\'s effect still happens once, a naive one\'s twice', async () => {
    const id = await seed(database.pool);
    const idempotent = new Recorder('idempotent');
    let naiveEffects = 0;
    const naive: OutboxConsumer = { name: 'naive', handle: async () => void (naiveEffects += 1) };
    const dying = dyingBeforeAcknowledgement();
    const relay = new OutboxRelay(dying.pool, new Map([['ThingHappened', [idempotent, naive]]]), POLICY);

    await expect(relay.drain(T0)).rejects.toThrow('died before it could acknowledge');
    expect(idempotent.effects.size).toBe(1);
    expect(naiveEffects).toBe(1);
    // claimed, so a second relay does not take it while the lease holds …
    const other = new Recorder('other');
    expect(await relayFor(other).drain(later(59_999))).toMatchObject({ claimed: 0 });
    // … and does once it has run out: delivered again, with the attempt counted
    expect(await relayFor(other).drain(later(60_000))).toMatchObject({ delivered: 1 });
    expect(other.seen[0]).toMatchObject({ messageId: id, attempt: 2 });
    // the second relay's consumer is a different object; the point is the original two, handed the message again by a relay of their own:
    const again = new OutboxRelay(database.pool, new Map([['ThingHappened', [idempotent, naive]]]), POLICY);
    await database.pool.query(`UPDATE platform.outbox_message SET published_at = NULL WHERE outbox_message_id = $1`, [id]);
    await again.drain(later(200_000));
    expect(idempotent.effects.size).toBe(1);
    expect(idempotent.seen).toHaveLength(2);
    expect(naiveEffects).toBe(2);
  });
});

describe('ordering — held per aggregate among live messages, and not across aggregates', () => {
  it('delivers an aggregate\'s messages in order, never a later one before an earlier one that is failing', async () => {
    const aggregate = randomUUID();
    const first = await seed(database.pool, { aggregateId: aggregate });
    const second = await seed(database.pool, { aggregateId: aggregate });
    const third = await seed(database.pool, { aggregateId: aggregate });
    const elsewhere = await seed(database.pool, { aggregateId: randomUUID() });
    const consumer = new Recorder();
    consumer.failWhile = (envelope) => envelope.messageId === first && envelope.attempt === 1;
    const relay = relayFor(consumer);

    const report = await relay.drain(T0);
    // the failing head blocks its own aggregate, and the other aggregate goes ahead
    expect(report).toMatchObject({ delivered: 1, retried: 1 });
    expect(consumer.seen.map((e) => e.messageId).sort()).toEqual([first, elsewhere].sort());
    expect((await state(second)).published_at).toBeNull();

    await relay.drain(later(1_000));
    const deliveredInOrder = consumer.seen.filter((e) => [first, second, third].includes(e.messageId) && !(e.messageId === first && e.attempt === 1)).map((e) => e.messageId);
    expect(deliveredInOrder).toEqual([first, second, third]);
  });

  it('delivers a message that has no earlier live message in the same drain as the head: one round per link of the chain', async () => {
    const aggregate = randomUUID();
    const ids = [await seed(database.pool, { aggregateId: aggregate }), await seed(database.pool, { aggregateId: aggregate })];
    const consumer = new Recorder();
    expect(await relayFor(consumer, { ...POLICY, maxRounds: 1 }).drain(T0)).toMatchObject({ delivered: 1 });
    expect(consumer.seen.map((e) => e.messageId)).toEqual([ids[0]]);
    expect(await relayFor(consumer, { ...POLICY, maxRounds: 5 }).drain(T0)).toMatchObject({ delivered: 1 });
    expect(consumer.seen.map((e) => e.messageId)).toEqual(ids);
  });
});

describe('a poison message does not stall the queue', () => {
  it('is dead-lettered after the attempts the policy allows, kept with its last error, and stops blocking its aggregate', async () => {
    const aggregate = randomUUID();
    const poison = await seed(database.pool, { aggregateId: aggregate });
    const after = await seed(database.pool, { aggregateId: aggregate });
    const consumer = new Recorder();
    consumer.failWhile = (envelope) => envelope.messageId === poison;
    const relay = relayFor(consumer);

    await relay.drain(T0); // attempt 1 fails
    await relay.drain(later(1_000)); // attempt 2 fails
    const last = await relay.drain(later(3_000)); // attempt 3: the policy's last
    expect(last).toMatchObject({ deadLettered: 1 });
    const dead = await state(poison);
    expect(dead.dead_at).not.toBeNull();
    expect(dead.published_at).toBeNull();
    expect(dead.attempts).toBe(3);
    expect(dead.last_error).toContain('refused');

    // the message behind it is delivered, in the same drain that buried it or the next
    await relay.drain(later(3_001));
    expect((await state(after)).published_at).not.toBeNull();
    // and the poison one is never offered again
    const seenBefore = consumer.seen.length;
    await relay.drain(later(1_000_000));
    expect(consumer.seen.length).toBe(seenBefore);

    expect(await relay.listDead()).toEqual([expect.objectContaining({ messageId: poison, attempts: 3, eventType: 'ThingHappened' })]);
  });

  it('can be put back by an operator once the cause is fixed, and is delivered', async () => {
    const poison = await seed(database.pool);
    const consumer = new Recorder();
    consumer.failWhile = () => true;
    const relay = relayFor(consumer, { ...POLICY, maxAttempts: 1 });
    await relay.drain(T0);
    expect((await state(poison)).dead_at).not.toBeNull();

    consumer.failWhile = () => false; // the bug is fixed
    expect(await relay.requeue(poison)).toBe(true);
    expect(await state(poison)).toMatchObject({ dead_at: null, attempts: 0, last_error: null });
    expect(await relay.drain(later(10))).toMatchObject({ delivered: 1 });
    expect(await relay.listDead()).toEqual([]);
  });

  it('says false for a message that is not dead, or not there', async () => {
    const live = await seed(database.pool);
    const relay = relayFor(new Recorder());
    expect(await relay.requeue(live)).toBe(false);
    expect(await relay.requeue(randomUUID())).toBe(false);
  });
});

describe('a failure retrying cannot mend (M7-16)', () => {
  it('is dead-lettered on the delivery that threw it, with its reason, while an ordinary failure is retried', async () => {
    const permanent = await seed(database.pool);
    const ordinary = await seed(database.pool);
    const consumer: OutboxConsumer = {
      name: 'picky',
      async handle(envelope) {
        if (envelope.messageId === permanent) throw new PermanentDeliveryFailure('names an item version nobody published');
        throw new Error('the store is down');
      },
    };
    const report = await relayFor(consumer).drain(T0);
    expect(report).toMatchObject({ claimed: 2, delivered: 0, retried: 1, deadLettered: 1 });

    const dead = await state(permanent);
    expect(dead.attempts).toBe(1);
    expect(dead.dead_at).not.toBeNull();
    expect(dead.last_error).toBe('PermanentDeliveryFailure: names an item version nobody published');
    const retry = await state(ordinary);
    expect(retry.dead_at).toBeNull();
    expect(retry.retry_at).not.toBeNull();
  });

  it('stops holding the aggregate behind it, as any dead-lettered message does, and can be put back by an operator', async () => {
    const aggregateId = randomUUID();
    const first = await seed(database.pool, { aggregateId });
    const second = await seed(database.pool, { aggregateId });
    const consumer = new Recorder();
    consumer.failWhile = () => false;
    const refusing: OutboxConsumer = {
      name: 'refusing-the-first',
      async handle(envelope) {
        if (envelope.messageId === first) throw new PermanentDeliveryFailure('cannot be acted on');
        await consumer.handle(envelope);
      },
    };
    const relay = relayFor(refusing);
    await relay.drain(T0);
    expect((await state(first)).dead_at).not.toBeNull();
    expect((await state(second)).published_at).not.toBeNull();
    expect(consumer.effects.has(second)).toBe(true);
    expect(await relay.requeue(first)).toBe(true);
  });
});

describe('concurrent relays', () => {
  it('deliver every message exactly once between them when nothing fails', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 40; i += 1) ids.add(await seed(database.pool));
    const a = new Recorder('a');
    const b = new Recorder('b');
    const racing = new Recorder('racing');
    await Promise.all([relayFor(a).drain(T0), relayFor(b).drain(T0), relayFor(racing).drain(T0)]);
    const c = new Recorder('c-final');
    await relayFor(c).drain(T0); // whatever the racing drains left
    const delivered = [...a.seen, ...b.seen, ...racing.seen, ...c.seen].map((e) => e.messageId);
    expect(delivered).toHaveLength(40);
    expect(new Set(delivered)).toEqual(ids);
    expect(a.seen.length + b.seen.length).toBeGreaterThan(0);
  });
});

describe('the outbox row is the producer\'s: a relay changes its delivery state and nothing else', () => {
  it('refuses a change to anything the producing transaction wrote, even from a role that could attempt it', async () => {
    const id = await seed(database.pool);
    await expect(database.pool.query(`UPDATE platform.outbox_message SET payload = '{"tampered": true}' WHERE outbox_message_id = $1`, [id])).rejects.toThrow(/platform_outbox_event_is_immutable/u);
    await expect(database.pool.query(`UPDATE platform.outbox_message SET event_type = 'Other' WHERE outbox_message_id = $1`, [id])).rejects.toThrow(/platform_outbox_event_is_immutable/u);
    await database.pool.query(`UPDATE platform.outbox_message SET attempts = 2 WHERE outbox_message_id = $1`, [id]);
  });

  it('gives the application role the delivery columns and not the event', async () => {
    const id = await seed(database.pool);
    const client = await database.pool.connect();
    try {
      await client.query('SET ROLE questionbank_app');
      await client.query(`UPDATE platform.outbox_message SET published_at = now(), attempts = 1, last_error = null WHERE outbox_message_id = $1`, [id]);
      await expect(client.query(`UPDATE platform.outbox_message SET payload = '{}' WHERE outbox_message_id = $1`, [id])).rejects.toThrow(/permission denied/u);
      await expect(client.query(`DELETE FROM platform.outbox_message WHERE outbox_message_id = $1`, [id])).rejects.toThrow(/permission denied/u);
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });

  it('refuses a message that is both published and dead', async () => {
    const id = await seed(database.pool);
    await expect(database.pool.query(`UPDATE platform.outbox_message SET published_at = now(), dead_at = now() WHERE outbox_message_id = $1`, [id])).rejects.toThrow(/outbox_message_published_xor_dead/u);
  });
});

describe('the payload discipline is a gate on what the relay emits (M6-38)', () => {
  const STEM = 'A block of mass 2 kg slides down a rough incline of 30 degrees; find the work done by friction over 5 m.';

  /** The material that must never reach a consumer: key fields by name, and the texts a stem, a solution and a justification carry. */
  const material = [...KEY_BEARING_FIELDS.map((field) => `"${field}"`), SOLUTION_TEXT, MISCONCEPTION_TEXT, STEM, 'The reviewer rejected it because the distractor is ambiguous.'];
  const scan = (envelope: unknown): string[] => {
    const serialized = JSON.stringify(envelope);
    return material.filter((fragment) => serialized.includes(fragment));
  };

  it('delivers nothing that carries a stem, a key, a solution or a justification — scanning every envelope the relay hands over, for messages produced by the real handlers', async () => {
    // Real production of messages: an item authored, reviewed with a solution and published through content's own handlers.
    // The item holds a key, a stem, a solution and a distractor's misconception — all of it in the database, none of it in an event.
    const item = await publishItem(database.pool, itemContent(STEM));
    expect(item.versions.length).toBeGreaterThan(0);

    const types = (await database.pool.query<{ event_type: string }>('SELECT DISTINCT event_type FROM platform.outbox_message')).rows.map((row) => row.event_type);
    expect(types.length).toBeGreaterThanOrEqual(2);

    const sink = new Recorder('sink');
    const report = await new OutboxRelay(database.pool, new Map(types.map((type) => [type, [sink]])), { ...POLICY, maxRounds: 50 }).drain(T0);
    expect(report.refused).toBe(0);
    expect(report.delivered).toBeGreaterThanOrEqual(types.length);
    expect(sink.seen.length).toBeGreaterThanOrEqual(types.length);
    expect(sink.seen.flatMap((envelope) => scan(envelope))).toEqual([]);
  });

  it('is not vacuous: the same scan finds the material in the content the events describe, and in a message that carries it', async () => {
    await publishItem(database.pool, itemContent(STEM));
    // What the events describe, as the content tables hold it: every row of every content table, as text.
    const tables = (await database.pool.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'content'`)).rows;
    let held = '';
    for (const { table_name } of tables) held += (await database.pool.query<{ r: string }>(`SELECT row_to_json(t)::text AS r FROM content."${table_name}" t`)).rows.map((row) => row.r).join('\n');
    const found = material.filter((fragment) => held.includes(fragment));
    // the key (as a column name), the stem and the solution are in the database: a scan of an emission could find them if they were there
    expect(found).toEqual(expect.arrayContaining(['"is_correct"', STEM, SOLUTION_TEXT, MISCONCEPTION_TEXT]));
    expect(scan({ planted: { stem: STEM, correctOptionId: 'b' } })).toEqual([STEM, '"correctOptionId"'].sort((a, b) => material.indexOf(a) - material.indexOf(b)));
  });

  it('refuses a message that carries it: dead-lettered before any consumer sees it, with the reason and without the material', async () => {
    const planted = await seed(database.pool, { payload: { scoreRecordId: randomUUID(), correctOptionId: 'b', stem: STEM } });
    const innocent = await seed(database.pool, { payload: { n: 1 } });
    const sink = new Recorder();
    const report = await relayFor(sink).drain(T0);
    expect(report).toMatchObject({ refused: 1, delivered: 1 });
    expect(sink.seen.map((e) => e.messageId)).toEqual([innocent]);
    const dead = await state(planted);
    expect(dead.dead_at).not.toBeNull();
    expect(dead.last_error).toContain('PAYLOAD_DISCIPLINE');
    expect(dead.last_error).toContain('$.correctOptionId (forbidden-field)');
    expect(dead.last_error).toContain('$.stem (forbidden-field)');
    expect(dead.last_error).not.toContain('slides down');
    expect(sink.seen.flatMap((envelope) => scan(envelope))).toEqual([]);
  });

  it('refuses prose under a name nobody listed', async () => {
    const planted = await seed(database.pool, { payload: { remark: STEM + ' ' + STEM } });
    const sink = new Recorder();
    expect(await relayFor(sink).drain(T0)).toMatchObject({ refused: 1, delivered: 0 });
    expect((await state(planted)).last_error).toContain('$.remark (prose)');
    expect(sink.seen).toEqual([]);
  });
});
