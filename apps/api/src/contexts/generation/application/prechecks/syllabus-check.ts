import { err, ok } from '../../domain/result.js';
import type { JudgementProvider, SyllabusReader, SyllabusVersion } from '../ports.js';
import type { CheckOutcome, PrecheckRunner } from './battery.js';
import { judgeIndependently, type JudgedCheckConfig } from './judge.js';
import { verdictFrom } from './judgement-checks.js';

/**
 * Check 5 — syllabus scope conformance (AI-ARCHITECTURE §11, blocking): "concept
 * membership + a classification call".
 *
 * **Membership is curriculum's to answer, not a list generation holds.** Every
 * concept the proposal is tagged with must be a member of the taxonomy version
 * it is tagged against, and that version must be published; both facts are read
 * from curriculum through its barrel. A tag list kept here would be a second
 * implementation of curriculum's syllabus, which is the drift this repository
 * has been bitten by three times.
 *
 * **Then a classification call**, under the check's own prompt (F29): given the
 * concepts curriculum says these are, is the question within their scope? The
 * model's rationale is the verdict's detail.
 *
 * What it cannot do is cross-check a *subject*: curriculum exposes no concept →
 * subject-domain lookup (debt D23). Membership in the syllabus is what is
 * checked; "this is physics" is the classification call's judgement.
 *
 * A failed membership is a verdict and short-circuits the call: there is nothing
 * to classify against a concept that is not in the syllabus. A curriculum that
 * cannot be read (it refuses the caller, or is unavailable) is a check that
 * could not run.
 */
export function syllabusScopeCheck(deps: {
  readonly syllabus: SyllabusReader;
  readonly judge: JudgementProvider;
  readonly config: JudgedCheckConfig;
}): PrecheckRunner {
  return {
    check: 'syllabus_scope',
    async run(candidate, context) {
      const { itemType, body } = candidate.content;
      const tags = body['taxonomyTags'];
      const readable = Array.isArray(tags)
        ? tags.filter(
            (tag): tag is { conceptIdentityId: string; taxonomyVersionId: string } =>
              typeof tag === 'object' && tag !== null && typeof tag.conceptIdentityId === 'string' && typeof tag.taxonomyVersionId === 'string',
          )
        : [];
      if (readable.length === 0) {
        return ok<CheckOutcome>({
          outcome: 'fail',
          detail: 'the proposal carries no concept tags, so nothing places it in the syllabus',
        });
      }

      const versions = new Map<string, SyllabusVersion | 'missing'>();
      for (const taxonomyVersionId of new Set(readable.map((tag) => tag.taxonomyVersionId))) {
        const read = await deps.syllabus.read(taxonomyVersionId, context);
        if (read.ok) versions.set(taxonomyVersionId, read.value);
        else if (read.error.kind === 'NotFound') versions.set(taxonomyVersionId, 'missing');
        else return err(read.error);
      }

      const problems: string[] = [];
      const concepts = new Map<string, string>();
      for (const tag of readable) {
        const version = versions.get(tag.taxonomyVersionId);
        if (version === 'missing' || version === undefined) {
          problems.push(`taxonomy version ${tag.taxonomyVersionId} does not exist`);
        } else if (version.state !== 'published') {
          problems.push(`taxonomy version ${tag.taxonomyVersionId} is ${version.state}, not published`);
        } else {
          const member = version.concepts.find((concept) => concept.conceptIdentityId === tag.conceptIdentityId);
          if (member === undefined) problems.push(`concept ${tag.conceptIdentityId} is not in taxonomy version ${tag.taxonomyVersionId}`);
          else concepts.set(member.conceptIdentityId, member.displayName);
        }
      }
      if (problems.length > 0) return ok<CheckOutcome>({ outcome: 'fail', detail: [...new Set(problems)].join('; ') });

      const answered = await judgeIndependently(deps.judge, candidate, 'syllabus_scope', deps.config, {
        itemType,
        stem: body['stem'],
        concepts: [...concepts].map(([conceptIdentityId, displayName]) => ({ conceptIdentityId, displayName })),
      });
      if (!answered.ok) return answered;
      return verdictFrom('syllabus_scope', answered.value.output);
    },
  };
}
