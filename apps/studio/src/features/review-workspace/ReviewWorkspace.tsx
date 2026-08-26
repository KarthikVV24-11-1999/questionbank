import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  ContentRenderer,
  MINIMUM_DEVICE_PROFILE,
  type ContentBody as RendererContentBody,
} from '@questionbank/content-renderer';
import { DecisionBar } from './DecisionBar.js';
import { DuplicatePanel } from './DuplicatePanel.js';
import { InlineEditor } from './InlineEditor.js';
import type {
  ClaimedItemBundle,
  DecisionSubmission,
  ReviewWorkspaceApi,
  ReviewerEdits,
  WireContentBody,
} from './review-workspace-model.js';

/**
 * The generated `WireContentBody` (from `@questionbank/contracts/content-schemas`)
 * is structurally looser than `ContentRenderer`'s own `Block` union — the
 * Zod generator has no discriminated-union support, so this cast is the one
 * place server-fetched content crosses into the renderer's real type. The
 * data itself is genuine `ContentBody`-shaped JSON; only the generated type
 * under-describes it (`review-workspace-model.ts`'s own header explains why).
 */
function asRendererBody(body: WireContentBody): RendererContentBody {
  return body as unknown as RendererContentBody;
}

/**
 * The review workspace (M4-38, UX §10.2) — one item, everything about it,
 * nothing behind a click.
 *
 * **Seven regions, always rendered together**: stem, options, solution,
 * tags, provenance, validation findings, duplicate candidates. None is
 * behind a `<details>`, a tab or a modal — a reviewer reading the stem and
 * a reviewer checking provenance are looking at the same screen.
 *
 * **Auto-advance is a state swap, never a navigation.** `advance()` never
 * touches `window.location` or `history` — the route a reviewer is on when
 * they start a session is the route they are on ten decisions later. The
 * next item is claimed the moment the current one is, in parallel, so the
 * swap on `advance()` is instant rather than a second request a reviewer
 * waits through.
 *
 * **This is an authoring-family surface** (DEC-M4-12) — it renders the
 * answer key inside `responseSpec`. `principalMayReview` is checked the
 * same way `ItemEditor`'s `principalMayAuthor` is: the server refuses
 * independently, and this is what keeps the key off the screen in the
 * meantime.
 */

type Loadable<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'empty' }
  | { readonly status: 'ready'; readonly value: T };

export interface ReviewWorkspaceProps {
  readonly api: ReviewWorkspaceApi;
  readonly subject: string;
  readonly principalMayReview: boolean;
  readonly undoWindowMs?: number;
}

function optionsLabel(itemType: string): string {
  return itemType === 'NUMERIC' ? 'This item takes a numeric answer — no options.' : '';
}

export function ReviewWorkspace(props: ReviewWorkspaceProps): JSX.Element {
  const { api, subject, principalMayReview } = props;

  const [current, setCurrent] = useState<Loadable<ClaimedItemBundle>>({ status: 'loading' });
  const [next, setNext] = useState<Loadable<ClaimedItemBundle>>({ status: 'loading' });
  const [selectedDuplicateId, setSelectedDuplicateId] = useState<string | null>(null);
  const [pendingEdits, setPendingEdits] = useState<ReviewerEdits | null>(null);
  const [sessionDecisions, setSessionDecisions] = useState(0);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // The current item — claimed once per mount/subject; advancing never re-runs this.
  useEffect(() => {
    if (!principalMayReview) return;
    let alive = true;
    api.claimNext(subject).then((bundle) => {
      if (!alive) return;
      setCurrent(bundle === null ? { status: 'empty' } : { status: 'ready', value: bundle });
    });
    return () => {
      alive = false;
    };
    // Deliberately excludes state that would re-trigger the initial claim on every advance.
  }, [api, subject, principalMayReview]);

  // The prefetch — fires whenever `next` needs filling, including the first
  // time (in parallel with the effect above) and every time `advance()`
  // resets it to `loading`.
  useEffect(() => {
    if (!principalMayReview || next.status !== 'loading') return;
    let alive = true;
    api.claimNext(subject).then((bundle) => {
      if (!alive) return;
      setNext(bundle === null ? { status: 'empty' } : { status: 'ready', value: bundle });
    });
    return () => {
      alive = false;
    };
  }, [api, subject, principalMayReview, next.status]);

  const currentAssignmentId = current.status === 'ready' ? current.value.assignment.assignmentId : null;
  useEffect(() => {
    if (currentAssignmentId !== null) headingRef.current?.focus();
  }, [currentAssignmentId]);

  const advance = useCallback((): void => {
    setCurrent(next);
    setNext({ status: 'loading' });
    setSelectedDuplicateId(null);
    setPendingEdits(null);
  }, [next]);

  const handleCommit = useCallback(
    (submission: DecisionSubmission): void => {
      setDecisionError(null);
      api.recordDecision(submission).catch(() => {
        setDecisionError('The decision could not be sent. The item stays claimed until you decide again.');
      });
      setSessionDecisions((count) => count + 1);
      advance();
    },
    [api, advance],
  );

  if (!principalMayReview) {
    return (
      <main>
        <h1>Review</h1>
        <p role="alert">You do not have a reviewer role. Nothing here is reachable without one.</p>
      </main>
    );
  }

  if (current.status === 'loading') {
    return (
      <main>
        <h1>Review</h1>
        <p role="status">Claiming the next item…</p>
      </main>
    );
  }

  if (current.status === 'empty') {
    return (
      <main>
        <h1>Review</h1>
        {/* Designed, not defaulted (UX §12): a cold queue is this product's first week. */}
        <p>Nothing is waiting for review in {subject} right now. Check back shortly.</p>
      </main>
    );
  }

  const bundle = current.value;
  const { version, validation, duplicates, solution, queueDepth } = bundle;

  return (
    <main>
      <h1 ref={headingRef} tabIndex={-1}>
        {`Review — ${subject}`}
      </h1>

      {decisionError !== null ? <p role="alert">{decisionError}</p> : null}

      <p>{`Queue depth: ${queueDepth}. Reviewed this session: ${sessionDecisions}.`}</p>

      <section aria-labelledby="stem-heading" data-region="stem">
        <h2 id="stem-heading">Stem</h2>
        <ContentRenderer body={asRendererBody(version.stem)} surface={MINIMUM_DEVICE_PROFILE} />
      </section>

      <section aria-labelledby="options-heading" data-region="options">
        <h2 id="options-heading">Options</h2>
        {version.responseSpec.options === undefined || version.responseSpec.options.length === 0 ? (
          <p>{optionsLabel(version.itemType) || 'No options on this item type.'}</p>
        ) : (
          <ul aria-label="Options">
            {version.responseSpec.options.map((option) => (
              <li key={option.optionId}>
                <ContentRenderer body={asRendererBody(option.body)} surface={MINIMUM_DEVICE_PROFILE} />
                {version.responseSpec.correctOptionId === option.optionId ||
                (version.responseSpec.correctOptionIds ?? []).includes(option.optionId) ? (
                  <strong> (correct)</strong>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="solution-heading" data-region="solution">
        <h2 id="solution-heading">Solution</h2>
        {solution.state === 'not_available' ? (
          <p>The solution's content is not available on this screen yet.</p>
        ) : (
          <ol aria-label="Solution steps">
            {solution.steps.map((step) => (
              <li key={step.ordinal}>
                <ContentRenderer body={asRendererBody(step.body)} surface={MINIMUM_DEVICE_PROFILE} />
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="tags-heading" data-region="tags">
        <h2 id="tags-heading">Taxonomy tags</h2>
        {version.taxonomyTags.length === 0 ? (
          <p>No tags.</p>
        ) : (
          <ul aria-label="Taxonomy tags">
            {version.taxonomyTags.map((tag) => (
              <li key={tag.conceptIdentityId}>
                {tag.conceptIdentityId}
                {tag.isPrimary ? ' (primary)' : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="provenance-heading" data-region="provenance">
        <h2 id="provenance-heading">Provenance</h2>
        <p>{`Source: ${version.provenance.sourceType}. Difficulty estimate: ${version.difficultyEstimate}.`}</p>
      </section>

      <section aria-labelledby="findings-heading" data-region="findings">
        <h2 id="findings-heading">Validation findings</h2>
        <h3>{`Blocking (${validation.blocking.length})`}</h3>
        {validation.blocking.length === 0 ? (
          <p>Nothing blocking.</p>
        ) : (
          <ul aria-label="Blocking findings">
            {validation.blocking.map((finding) => (
              <li key={finding.code}>{`${finding.message} (${finding.location})`}</li>
            ))}
          </ul>
        )}
        <h3>{`Warnings (${validation.warnings.length})`}</h3>
        {validation.warnings.length === 0 ? (
          <p>No warnings.</p>
        ) : (
          <ul aria-label="Warning findings">
            {validation.warnings.map((finding) => (
              <li key={finding.code}>{`${finding.message} (${finding.location})`}</li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="duplicates-heading" data-region="duplicates">
        <h2 id="duplicates-heading">Duplicates</h2>
        <DuplicatePanel
          duplicates={duplicates}
          selectedItemId={selectedDuplicateId}
          onSelect={setSelectedDuplicateId}
        />
      </section>

      <InlineEditor
        stemPreview={<ContentRenderer body={asRendererBody(version.stem)} surface={MINIMUM_DEVICE_PROFILE} />}
        currentTaxonomyTags={version.taxonomyTags}
        currentDifficultyEstimate={version.difficultyEstimate}
        onChange={setPendingEdits}
      />

      <DecisionBar
        itemId={bundle.assignment.itemId}
        itemVersionId={bundle.assignment.itemVersionId}
        assignmentId={bundle.assignment.assignmentId}
        candidatesShownIds={[
          ...duplicates.exact.map((c) => c.itemVersionId),
          ...duplicates.skeleton.map((c) => c.itemVersionId),
          ...duplicates.trigram.map((c) => c.itemVersionId),
        ]}
        selectedDuplicateId={selectedDuplicateId}
        pendingEdits={pendingEdits}
        onCommit={handleCommit}
        {...(props.undoWindowMs === undefined ? {} : { undoWindowMs: props.undoWindowMs })}
      />
    </main>
  );
}
