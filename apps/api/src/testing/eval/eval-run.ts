import { randomUUID } from 'node:crypto';
import type { BatteryReport } from '../../contexts/generation/application/prechecks/battery.js';
import type { GenerationCandidate } from '../../contexts/generation/domain/generation-candidate.js';
import { createGenerationCandidate } from '../../contexts/generation/domain/generation-candidate.js';
import type { GenerationCandidateRepository } from '../../contexts/generation/domain/repository-ports.js';
import { precheckSeverity } from '../../contexts/generation/domain/precheck-vocabulary.js';
import { expectValue } from '../expect-result.js';
import { DEFECTS, DEFECT_PLAN, officialItemCount, type Defect, type EvalCorpus, type EvalItem } from './eval-corpus.js';

/**
 * Runs the corpus through the battery as the application composes it (M5-44) and
 * reports what happened to each item. Nothing here judges: an item is *caught* when
 * the battery's own disposition is a rejection, and *let through* when it is an
 * acceptance — which is the same fact a reviewer's queue would show.
 */
export interface EvalItemResult {
  readonly item: EvalItem;
  readonly disposition: 'accepted' | 'rejected' | 'undecided' | 'failed';
  /** The blocking checks that recorded a failing verdict. */
  readonly failedBlocking: readonly string[];
}

export interface EvalRunner {
  /** Starts a run for the item, stores it as a candidate under it, runs the battery, and reports. */
  run(item: EvalItem): Promise<EvalItemResult>;
}

export interface EvalRunnerDeps {
  readonly startRun: () => Promise<{ readonly pin: { readonly modelVersionId: string; readonly promptVersionId: string; readonly runId: string } }>;
  readonly candidates: GenerationCandidateRepository;
  readonly runBattery: (candidateId: string) => Promise<BatteryReport>;
}

export function evalRunner(deps: EvalRunnerDeps): EvalRunner {
  return {
    async run(item) {
      const run = await deps.startRun();
      const candidate: GenerationCandidate = expectValue(
        createGenerationCandidate({
          candidateId: randomUUID(),
          pin: run.pin,
          content: { itemType: item.itemType, body: item.body },
          verdicts: [],
          confidence: 0.8,
        }),
      );
      expectValue(await deps.candidates.save(candidate));
      const report = await deps.runBattery(candidate.candidateId);
      const failedBlocking = report.checks
        .filter((line) => line.status === 'recorded' && line.outcome === 'fail' && precheckSeverity(line.check) === 'blocking')
        .map((line) => line.check);
      return { item, disposition: report.disposition.status, failedBlocking };
    },
  };
}

export interface EvalReport {
  readonly corpusVersion: string;
  readonly knownBad: number;
  readonly caught: number;
  /** caught / knownBad — F34's number. */
  readonly catchRate: number;
  readonly structural: { readonly total: number; readonly caught: number };
  readonly judged: { readonly total: number; readonly caught: number };
  readonly uncatchable: { readonly total: number; readonly caught: number };
  readonly byDefect: Readonly<Record<Defect, { total: number; caught: number }>>;
  /** Known-bad items the battery let through to a reviewer. */
  readonly missed: readonly string[];
  readonly positives: number;
  /** Positives the battery accepted: the synthetic stand-in for generation acceptance. */
  readonly positivesAccepted: number;
  readonly officialItems: number;
}

export function reportOf(corpus: EvalCorpus, known: readonly EvalItemResult[], positives: readonly EvalItemResult[]): EvalReport {
  const byDefect = Object.fromEntries(DEFECTS.map((defect) => [defect, { total: 0, caught: 0 }])) as Record<Defect, { total: number; caught: number }>;
  const missed: string[] = [];
  for (const result of known) {
    const defect = result.item.defect as Defect;
    byDefect[defect].total += 1;
    if (result.disposition === 'rejected') byDefect[defect].caught += 1;
    else missed.push(result.item.id);
  }
  const sum = (kind: 'structural' | 'judged' | 'uncatchable') =>
    DEFECTS.filter((defect) => DEFECT_PLAN[defect].kind === kind).reduce(
      (total, defect) => ({ total: total.total + byDefect[defect].total, caught: total.caught + byDefect[defect].caught }),
      { total: 0, caught: 0 },
    );
  const caught = known.filter((result) => result.disposition === 'rejected').length;
  return {
    corpusVersion: corpus.version,
    knownBad: known.length,
    caught,
    catchRate: known.length === 0 ? 0 : caught / known.length,
    structural: sum('structural'),
    judged: sum('judged'),
    uncatchable: sum('uncatchable'),
    byDefect,
    missed,
    positives: positives.length,
    positivesAccepted: positives.filter((result) => result.disposition === 'accepted').length,
    officialItems: officialItemCount(corpus),
  };
}

/**
 * The report in words, with what it does and does not establish said plainly — the
 * honesty the scoring golden set applies: *a run with zero official items is not a
 * validated run.*
 */
export function describeEvaluation(report: EvalReport): string {
  const pct = (part: number, whole: number) => (whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(1)}%`);
  return [
    `Evaluation over ${report.corpusVersion}: ${report.officialItems} official items and ${report.knownBad + report.positives} synthetic ones, so this is not a validated run — the 250 real items with official keys are blocked on the licensing decision (B1).`,
    `Verification catch rate on known-bad items: ${report.caught} of ${report.knownBad} = ${pct(report.caught, report.knownBad)} (F34 requires at least 95%).`,
    `  structural defects, caught by checks that are real code over the proposal: ${report.structural.caught} of ${report.structural.total} = ${pct(report.structural.caught, report.structural.total)}.`,
    `  judged defects, answered by an oracle that knows the truth about each item: ${report.judged.caught} of ${report.judged.total} = ${pct(report.judged.caught, report.judged.total)}. This measures the battery turning a verifier's finding into a block, not a model's sensitivity, which needs a live provider (D45).`,
    `  defects no check exists for (difficulty mislabel, check 9 blocked, D42): ${report.uncatchable.caught} of ${report.uncatchable.total}.`,
    `  missed: ${report.missed.length === 0 ? 'none' : report.missed.join(', ')}.`,
    `Synthetic positives accepted by the pipeline: ${report.positivesAccepted} of ${report.positives} = ${pct(report.positivesAccepted, report.positives)}. This stands in for generation acceptance; it is not first-pass reviewer acceptance, which is blocked on a reviewer pool (DEC-M5-1).`,
  ].join('\n');
}
