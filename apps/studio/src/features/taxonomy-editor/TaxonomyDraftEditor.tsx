import { useCallback, useMemo, useState } from 'react';
import type { ConceptNode } from '@questionbank/contracts';
import {
  draftViolations,
  moveWouldCreateCycle,
  publicationPreconditions,
  type DraftState,
} from './draft-editor-model.js';

export interface DraftEditorApi {
  createDraft(source: { readonly cloneOf?: string; readonly examFamily: string; readonly academicYear: string }): Promise<{
    readonly taxonomyVersionId: string;
    readonly aggregateVersion: number;
    readonly nodes: readonly ConceptNode[];
  }>;
  saveDraft(
    taxonomyVersionId: string,
    draft: DraftState,
    expectedAggregateVersion: number,
  ): Promise<{ readonly ok: true; readonly aggregateVersion: number } | { readonly ok: false; readonly conflict: true }>;
  publish(
    taxonomyVersionId: string,
    expectedAggregateVersion: number,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
}

export interface TaxonomyDraftEditorProps {
  readonly api: DraftEditorApi;
  readonly examFamily: string;
  readonly academicYear: string;
}

interface EditorState {
  readonly taxonomyVersionId: string;
  readonly aggregateVersion: number;
  readonly draft: DraftState;
}

let nextLocalId = 0;

function localNodeId(): string {
  nextLocalId += 1;
  return `019fd4bc-1111-7000-8000-${nextLocalId.toString(16).padStart(12, '0')}`;
}

/**
 * Create and edit a draft taxonomy version (M1-33). Invariant violations
 * surface inline as the curator edits; publication is offered only once every
 * precondition is met.
 */
export function TaxonomyDraftEditor({ api, examFamily, academicYear }: TaxonomyDraftEditorProps) {
  const [state, setState] = useState<EditorState | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [conflict, setConflict] = useState(false);
  const [published, setPublished] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const violations = useMemo(
    () => (state === null ? [] : draftViolations(state.draft)),
    [state],
  );
  const preconditions = useMemo(
    () => (state === null ? [] : publicationPreconditions(state.draft)),
    [state],
  );
  const canPublish = state !== null && preconditions.every((precondition) => precondition.met);

  const start = useCallback(
    async (cloneOf?: string) => {
      const created = await api.createDraft({
        examFamily,
        academicYear,
        ...(cloneOf !== undefined ? { cloneOf } : {}),
      });
      setState({
        taxonomyVersionId: created.taxonomyVersionId,
        aggregateVersion: created.aggregateVersion,
        draft: { nodes: [...created.nodes], prerequisites: [] },
      });
      setPublished(false);
      setConflict(false);
    },
    [api, academicYear, examFamily],
  );

  const addConcept = useCallback(() => {
    if (state === null || name.trim() === '') return;

    const parent = state.draft.nodes.find((node) => node.conceptNodeId === selectedNodeId) ?? null;
    const node: ConceptNode = {
      conceptNodeId: localNodeId(),
      conceptIdentityId: localNodeId(),
      parentNodeId: parent?.conceptNodeId ?? null,
      displayName: name.trim(),
      examWeight: 0,
      depth: parent === null ? 0 : parent.depth + 1,
      estimatedTeachingHours: 0,
    };

    setState({ ...state, draft: { ...state.draft, nodes: [...state.draft.nodes, node] } });
    setName('');
  }, [name, selectedNodeId, state]);

  const renameConcept = useCallback(() => {
    if (state === null || selectedNodeId === null || name.trim() === '') return;

    setState({
      ...state,
      draft: {
        ...state.draft,
        nodes: state.draft.nodes.map((node) =>
          node.conceptNodeId === selectedNodeId ? { ...node, displayName: name.trim() } : node,
        ),
      },
    });
    setName('');
  }, [name, selectedNodeId, state]);

  const removeConcept = useCallback(() => {
    if (state === null || selectedNodeId === null) return;

    setState({
      ...state,
      draft: {
        ...state.draft,
        nodes: state.draft.nodes.filter((node) => node.conceptNodeId !== selectedNodeId),
      },
    });
    setSelectedNodeId(null);
  }, [selectedNodeId, state]);

  const moveConcept = useCallback(
    (newParentId: string) => {
      if (state === null || selectedNodeId === null) return;

      if (moveWouldCreateCycle(state.draft.nodes, selectedNodeId, newParentId)) {
        setPublishError('That move would put the concept inside its own subtree.');
        return;
      }

      const parent = state.draft.nodes.find((node) => node.conceptNodeId === newParentId);
      setPublishError(null);
      setState({
        ...state,
        draft: {
          ...state.draft,
          nodes: state.draft.nodes.map((node) =>
            node.conceptNodeId === selectedNodeId
              ? { ...node, parentNodeId: newParentId, depth: (parent?.depth ?? 0) + 1 }
              : node,
          ),
        },
      });
    },
    [selectedNodeId, state],
  );

  const addPrerequisite = useCallback(
    (fromConceptIdentityId: string, toConceptIdentityId: string) => {
      if (state === null) return;
      setState({
        ...state,
        draft: {
          ...state.draft,
          prerequisites: [...state.draft.prerequisites, { fromConceptIdentityId, toConceptIdentityId }],
        },
      });
    },
    [state],
  );

  const save = useCallback(async () => {
    if (state === null) return;

    const saved = await api.saveDraft(state.taxonomyVersionId, state.draft, state.aggregateVersion);
    if (!saved.ok) {
      setConflict(true);
      return;
    }
    setConflict(false);
    setState({ ...state, aggregateVersion: saved.aggregateVersion });
  }, [api, state]);

  const publish = useCallback(async () => {
    if (state === null || !canPublish) return;

    const outcome = await api.publish(state.taxonomyVersionId, state.aggregateVersion);
    if (outcome.ok) {
      setPublished(true);
      setPublishError(null);
      return;
    }
    setPublishError(outcome.message);
  }, [api, canPublish, state]);

  if (state === null) {
    return (
      <main>
        <h1>Taxonomy draft editor</h1>
        <button type="button" onClick={() => void start()}>
          Create empty draft
        </button>
        <button type="button" onClick={() => void start('published-version')}>
          Clone published version
        </button>
      </main>
    );
  }

  return (
    <main>
      <h1>Taxonomy draft editor</h1>

      {published ? <p role="status">Published. This version is now read-only.</p> : null}
      {conflict ? (
        <p role="alert">
          Someone else changed this version while you were editing. Reload before saving — your edits
          have not been applied.
        </p>
      ) : null}
      {publishError !== null ? <p role="alert">{publishError}</p> : null}

      <fieldset disabled={published}>
        <legend>Edit concepts</legend>

        <label htmlFor="concept-name">Concept name</label>
        <input id="concept-name" value={name} onChange={(event) => setName(event.target.value)} />

        <button type="button" onClick={addConcept}>
          Add concept
        </button>
        <button type="button" onClick={renameConcept} disabled={selectedNodeId === null}>
          Rename concept
        </button>
        <button type="button" onClick={removeConcept} disabled={selectedNodeId === null}>
          Remove concept
        </button>

        <label htmlFor="move-target">Move under</label>
        <select
          id="move-target"
          value=""
          onChange={(event) => moveConcept(event.target.value)}
          disabled={selectedNodeId === null}
        >
          <option value="">Choose a parent…</option>
          {state.draft.nodes
            .filter((node) => node.conceptNodeId !== selectedNodeId)
            .map((node) => (
              <option key={node.conceptNodeId} value={node.conceptNodeId}>
                {node.displayName}
              </option>
            ))}
        </select>

        <label htmlFor="prerequisite-target">Add prerequisite from selected concept to</label>
        <select
          id="prerequisite-target"
          value=""
          onChange={(event) => {
            const selected = state.draft.nodes.find((node) => node.conceptNodeId === selectedNodeId);
            const target = state.draft.nodes.find((node) => node.conceptNodeId === event.target.value);
            if (selected !== undefined && target !== undefined) {
              addPrerequisite(selected.conceptIdentityId, target.conceptIdentityId);
            }
          }}
          disabled={selectedNodeId === null}
        >
          <option value="">Choose a concept…</option>
          {state.draft.nodes.map((node) => (
            <option key={node.conceptNodeId} value={node.conceptNodeId}>
              {node.displayName}
            </option>
          ))}
        </select>
      </fieldset>

      <nav aria-label="Draft concepts">
        <ul>
          {state.draft.nodes.map((node) => (
            <li key={node.conceptNodeId}>
              <button
                type="button"
                aria-current={selectedNodeId === node.conceptNodeId ? 'true' : undefined}
                onClick={() => setSelectedNodeId(node.conceptNodeId)}
              >
                {node.displayName}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <section aria-labelledby="violations-heading">
        <h2 id="violations-heading">Problems</h2>
        {violations.length === 0 ? (
          <p role="status">No problems found.</p>
        ) : (
          <ul aria-live="polite">
            {violations.map((violation) => (
              <li key={`${violation.code}:${violation.conceptNodeIds.join(',')}`}>{violation.message}</li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="publication-heading">
        <h2 id="publication-heading">Publication</h2>
        <ul>
          {preconditions.map((precondition) => (
            <li key={precondition.label}>
              {precondition.met ? '✓' : '✗'} {precondition.label}
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => void save()} disabled={published}>
          Save draft
        </button>
        <button type="button" onClick={() => void publish()} disabled={!canPublish || published}>
          Publish
        </button>
      </section>
    </main>
  );
}
