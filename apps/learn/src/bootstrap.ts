import type { AssessmentApi } from './api/assessment-api.js';
import { loadPackage, type PackageRefusal } from './package/load.js';
import type { FormPackage } from './package/types.js';
import { AttemptSession } from './session/attempt-session.js';
import { activeAttemptId, loadRecord } from './session/persistence.js';
import type { SessionPorts } from './session/ports.js';

/**
 * Brings the sitting up (M6-47, M6-48, M6-50): the signed package, then the attempt — resumed if this device was already sitting it,
 * created and started if not.
 *
 * Two gaps are known and recorded: a tab reopened while the backend is down cannot resume (debt D67), and a device with no record of the attempt
 * begins an empty log rather than reading the server's (debt D68).
 *
 * The order is the point. **The package is fetched and verified before anything else**, and nothing is created, started or shown if it
 * does not verify: an attempt must not begin on a paper nobody vouched for. If this device was mid-attempt, the server's own fresh
 * reading of the attempt gives the deadline, so a reload carries on against the same deadline and never restarts it.
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

export async function boot(params: BootParams): Promise<BootResult> {
  const { api, ports } = params;
  const [response, key] = await Promise.all([api.getPackage(params.formId), api.getSigningKey()]);
  const loaded = await loadPackage(response, key);
  if (!loaded.ok) return { kind: 'package-refused', refusal: loaded.refusal };

  const activeId = activeAttemptId(ports.storage);
  const record = activeId === null ? null : loadRecord(ports.storage, activeId);
  if (record !== null) {
    const server = await api.getAttempt(record.attemptId);
    if (server.formId === loaded.form.form.formId && (server.state === 'in_progress' || server.state === 'submitted')) {
      return { kind: 'ready', session: AttemptSession.resume({ record, server }, ports), form: loaded.form };
    }
  }

  const created = await api.createAttempt(params.formId, params.sessionRef, params.idempotencyKey);
  const started = await api.startAttempt(created.attemptId);
  if (started.deadline === null) return { kind: 'cannot-start', reason: 'the server did not give a deadline' };
  return {
    kind: 'ready',
    session: AttemptSession.begin(
      { attemptId: started.attemptId, deviceRef: params.deviceRef, intervalCapMs: started.intervalCapMs, deadline: started.deadline, serverNow: started.serverNow },
      ports,
    ),
    form: loaded.form,
  };
}
