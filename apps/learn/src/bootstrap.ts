import type { AssessmentApi } from './api/assessment-api.js';
import { loadPackage, type PackageRefusal } from './package/load.js';
import type { FormPackage } from './package/types.js';
import { AttemptSession } from './session/attempt-session.js';
import { activeAttemptId, loadRecord } from './session/persistence.js';
import type { SessionPorts } from './session/ports.js';

/**
 * Brings the sitting up (M6-47, M6-48, M6-50, M7-56): the signed package, then the attempt — resumed if this device was already sitting it,
 * continued from the server's log if another device was (D68), created and started if neither.
 *
 * **The device is read first** (D67, DEC-M7-30, ADR-0055). What this device wrote down about the attempt survives an outage, so it is read before anything that needs the network:
 * it is the one thing the order of these calls must not make depend on the network being up. And **the package is verified before anything is created,
 * started or shown**, whatever the record says: an attempt must not begin on a paper nobody vouched for, and a record is carried on only against a
 * paper that verified and is of the form the record is. The package and its key come from the service worker's copy when the network is down; they are
 * verified from it as from the network.
 *
 * With the record and the package in hand the server is asked for the attempt, to take its deadline afresh so a reload never restarts the clock. If it
 * cannot be reached — the network is down, or the server is failing (5xx) — a record that says which form it is of and holds an offset to the server's
 * clock carries on from the device alone, against the deadline it wrote down. A refusal that is not an outage (the server answered and said no) is
 * not an outage and is not carried through.
 */
export type BootResult =
  | { readonly kind: 'ready'; readonly session: AttemptSession; readonly form: FormPackage }
  | { readonly kind: 'package-refused'; readonly refusal: PackageRefusal }
  | { readonly kind: 'cannot-start'; readonly reason: string };

export interface BootParams {
  readonly api: AssessmentApi;
  readonly ports: SessionPorts;
  readonly formId: string;
  readonly sessionRef: string;
  readonly deviceRef: string;
  /** A key the student's tap on "begin" made, so a retried create returns the same attempt. */
  readonly idempotencyKey: string;
}

/** Whether a failure is the server being out of reach, as opposed to the server answering. `fetch` rejects with a `TypeError` when it cannot connect; a 5xx is a server that is down or failing. */
function unreachable(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const problem = error as { status?: unknown; problem?: { status?: unknown } };
  const status = problem.status ?? problem.problem?.status;
  return typeof status === 'number' && status >= 500;
}

export async function boot(params: BootParams): Promise<BootResult> {
  const { api, ports } = params;
  const activeId = activeAttemptId(ports.storage);
  const record = activeId === null ? null : loadRecord(ports.storage, activeId);

  const [response, key] = await Promise.all([api.getPackage(params.formId), api.getSigningKey()]);
  const loaded = await loadPackage(response, key);
  if (!loaded.ok) return { kind: 'package-refused', refusal: loaded.refusal };
  const formId = loaded.form.form.formId;

  if (record !== null) {
    let server: Awaited<ReturnType<AssessmentApi['getAttempt']>> | null = null;
    try {
      server = await api.getAttempt(record.attemptId);
    } catch (error) {
      if (!unreachable(error) || record.formId !== formId || record.serverOffsetMs === null) throw error;
      return { kind: 'ready', session: AttemptSession.resume({ record: { ...record, formId, serverOffsetMs: record.serverOffsetMs }, server: null }, ports), form: loaded.form };
    }
    if (server.formId === formId && (server.state === 'in_progress' || server.state === 'submitted')) {
      return { kind: 'ready', session: AttemptSession.resume({ record, server }, ports), form: loaded.form };
    }
  }

  const created = await api.createAttempt(params.formId, params.sessionRef, params.idempotencyKey);
  const started = await api.startAttempt(created.attemptId);
  if (started.deadline === null) return { kind: 'cannot-start', reason: 'the server did not give a deadline' };
  // An attempt that already has a log — this is a second device, or this one after its storage was cleared — carries on from it and its numbering (D68).
  const held = await api.getAttempt(started.attemptId);
  if (held.events.length > 0) {
    return { kind: 'ready', session: AttemptSession.resume({ record: null, server: held, deviceRef: params.deviceRef }, ports), form: loaded.form };
  }
  return {
    kind: 'ready',
    session: AttemptSession.begin(
      { attemptId: started.attemptId, formId, deviceRef: params.deviceRef, intervalCapMs: started.intervalCapMs, deadline: started.deadline, serverNow: started.serverNow },
      ports,
    ),
    form: loaded.form,
  };
}
