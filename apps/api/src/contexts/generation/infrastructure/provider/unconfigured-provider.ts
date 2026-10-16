import { err, type Result } from '../../domain/result.js';
import { applicationError, type ApplicationError } from '../../application/authorization.js';
import type {
  JudgementProvider,
  JudgementRequest,
  JudgementResponse,
  ProposalProvider,
  ProposalRequest,
  ProposalResponse,
} from '../../application/ports.js';

/**
 * The provider a deployment has when none was chosen: every call is refused as
 * unavailable, and nothing is invented (M5-37).
 *
 * No live adapter exists yet, and the replay adapter answers from committed
 * recordings, which is a test fixture and not a production behaviour. Composing
 * generation therefore needs something to stand in the provider's place, and it
 * must not be something that answers. `Unavailable` is the kind the architecture
 * already gives an unreachable provider — "queue and retry; no student path
 * depends on live AI" (AI-12) — so a run proposed against this adapter fails in
 * the way a run against a provider that is down does, and a caller already
 * handles that.
 *
 * It holds no credential, reads no environment and makes no call. That no live adapter exists
 * is debt D45.
 */
const NOT_CONFIGURED = (what: string): ApplicationError =>
  applicationError(
    'Unavailable',
    'PROVIDER_NOT_CONFIGURED',
    `no provider is configured for ${what}; the pipeline cannot reach a model until a deployment supplies one`,
  );

export class UnconfiguredProvider implements ProposalProvider, JudgementProvider {
  async propose(_request: ProposalRequest): Promise<Result<ProposalResponse, ApplicationError>> {
    return err(NOT_CONFIGURED('proposals'));
  }

  async judge(_request: JudgementRequest): Promise<Result<JudgementResponse, ApplicationError>> {
    return err(NOT_CONFIGURED('judgements'));
  }
}
