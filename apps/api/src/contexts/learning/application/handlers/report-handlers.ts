import { ROLES } from '../../../../platform/auth/roles.js';
import { findingsOf, type Finding, type ReportSlot } from '../../domain/diagnostic-report.js';
import { err, ok, type Result } from '../../domain/result.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import type { ApplicationContext, Clock, ConceptReader, DiagnosticReportStore, IdentifierFactory } from '../ports.js';
import { DEFAULT_REMEDIATION_LIMIT } from './remediation-handler.js';

/**
 * `GenerateDiagnosticReport` — the report for one scored mock (M7-42). The system's alone: the relay's consumer runs it when a score is written, and again when a
 * re-score replaces it, which gives a new report beside the old one and never changes the old one (D3). The same score record twice is one report.
 */
export const GENERATE_DIAGNOSTIC_REPORT_POLICY = policy('GenerateDiagnosticReport', [ROLES.system]);

export interface GenerateDiagnosticReport {
  readonly learnerRef: string;
  readonly attemptRef: string;
  readonly scoreRecordRef: string;
  readonly slots: readonly ReportSlot[];
}

export interface GeneratedReport {
  readonly reportId: string | null;
  /** `false` for a score record that already has its report: nothing was written. */
  readonly created: boolean;
  readonly findings: readonly Finding[];
}

export class GenerateDiagnosticReportHandler {
  readonly name = 'GenerateDiagnosticReport';
  readonly policy = GENERATE_DIAGNOSTIC_REPORT_POLICY;

  constructor(private readonly deps: { readonly reports: DiagnosticReportStore; readonly clock: Clock; readonly identifiers: IdentifierFactory }) {}

  async handle(command: GenerateDiagnosticReport, context: ApplicationContext): Promise<Result<GeneratedReport, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const findings = findingsOf(command.slots);
    const reportId = this.deps.identifiers.next();
    const stored = await this.deps.reports.insert({ reportId, learnerRef: command.learnerRef, attemptRef: command.attemptRef, scoreRecordRef: command.scoreRecordRef, generatedAt: this.deps.clock.now().toISOString(), findings });
    if (!stored.ok) return err(stored.error);
    return ok(Object.freeze({ reportId: stored.value ? reportId : null, created: stored.value, findings }));
  }
}

/**
 * What remediation for a finding would be (M7-43): targeted practice about its concept. Which concepts a targeted run is about is Learning's judgement alone
 * (M7-28, DEC-M7-1): the run is built from the learner's weakest concepts, so `selected` says whether this finding's concept is among the ones that run would take,
 * read now and not when the report was made. A finding whose concept is not selected is still a finding; the run just would not be about it yet.
 */
export interface Remediation {
  readonly strategy: 'targeted';
  readonly taxonomyVersionId: string;
  readonly conceptIdentityId: string;
  readonly selected: boolean;
}

export interface ReportedFinding extends Finding {
  readonly remediation: Remediation;
}

export interface DiagnosticReportView {
  readonly reportId: string;
  readonly attemptId: string;
  readonly generatedAt: string;
  readonly findings: readonly ReportedFinding[];
}

export const GET_DIAGNOSTIC_REPORT_POLICY = policy('GetDiagnosticReport', [ROLES.learner]);

/** The learner's own report for an attempt. There is no learner parameter, so there is no way to ask for someone else's. */
export class GetDiagnosticReportHandler {
  readonly name = 'GetDiagnosticReport';
  readonly policy = GET_DIAGNOSTIC_REPORT_POLICY;

  constructor(private readonly deps: { readonly reports: DiagnosticReportStore; readonly concepts: ConceptReader }) {}

  async handle(query: { readonly attemptId: string }, context: ApplicationContext): Promise<Result<DiagnosticReportView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const found = await this.deps.reports.latest(context.principal.id, query.attemptId);
    if (!found.ok) return err(found.error);
    if (found.value === null) return err(applicationError('NotFound', 'REPORT_NOT_FOUND', 'there is no report for that attempt'));

    const targeted = new Map<string, ReadonlySet<string>>();
    for (const taxonomy of new Set(found.value.findings.map((f) => f.taxonomyVersionId))) {
      const weakest = await this.deps.concepts.weakest(context.principal.id, taxonomy, DEFAULT_REMEDIATION_LIMIT);
      if (!weakest.ok) return err(weakest.error);
      targeted.set(taxonomy, new Set(weakest.value));
    }
    const findings = found.value.findings.map((f) =>
      Object.freeze({ ...f, remediation: Object.freeze({ strategy: 'targeted' as const, taxonomyVersionId: f.taxonomyVersionId, conceptIdentityId: f.conceptIdentityId, selected: targeted.get(f.taxonomyVersionId)!.has(f.conceptIdentityId) }) }),
    );
    return ok(Object.freeze({ reportId: found.value.reportId, attemptId: query.attemptId, generatedAt: found.value.generatedAt, findings: Object.freeze(findings) }));
  }
}
