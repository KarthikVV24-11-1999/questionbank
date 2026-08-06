import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConceptNode, ConceptPrerequisites, TaxonomyVersionDetail, TaxonomyVersionSummary } from '@questionbank/contracts';
import type { CurriculumClient } from './curriculum-client.js';

export interface TaxonomyBrowserProps {
  readonly client: CurriculumClient;
  readonly examFamily: string;
}

interface TreeNodeProps {
  readonly node: ConceptNode;
  readonly childrenOf: (parentNodeId: string) => readonly ConceptNode[];
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (conceptNodeId: string) => void;
  readonly onSelect: (node: ConceptNode) => void;
  readonly selectedNodeId: string | null;
}

/**
 * One branch of the concept tree. Children render only once their parent is
 * expanded, so a 600-node version costs one row until the curator asks for more.
 */
function TreeNode({ node, childrenOf, expanded, onToggle, onSelect, selectedNodeId }: TreeNodeProps) {
  const children = childrenOf(node.conceptNodeId);
  const isExpanded = expanded.has(node.conceptNodeId);
  const hasChildren = children.length > 0;

  return (
    <li>
      <div className="tree-row">
        {hasChildren ? (
          <button
            type="button"
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${node.displayName}`}
            onClick={() => onToggle(node.conceptNodeId)}
          >
            {isExpanded ? '−' : '+'}
          </button>
        ) : (
          <span aria-hidden="true" className="tree-leaf-spacer" />
        )}
        <button
          type="button"
          aria-current={selectedNodeId === node.conceptNodeId ? 'true' : undefined}
          onClick={() => onSelect(node)}
        >
          {node.displayName}
        </button>
      </div>
      {hasChildren && isExpanded ? (
        <ul>
          {children.map((child) => (
            <TreeNode
              key={child.conceptNodeId}
              node={child}
              childrenOf={childrenOf}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
              selectedNodeId={selectedNodeId}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Read-only navigation of a published taxonomy (M1-32). Published versions are
 * visibly read-only: there is no edit affordance anywhere in this view.
 */
export function TaxonomyBrowser({ client, examFamily }: TaxonomyBrowserProps) {
  const [versions, setVersions] = useState<readonly TaxonomyVersionSummary[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [version, setVersion] = useState<TaxonomyVersionDetail | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selectedNode, setSelectedNode] = useState<ConceptNode | null>(null);
  const [prerequisites, setPrerequisites] = useState<ConceptPrerequisites | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    client
      .listTaxonomyVersions(examFamily)
      .then((found) => {
        if (cancelled) return;
        setVersions(found);
        setSelectedVersionId(found[0]?.taxonomyVersionId ?? null);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [client, examFamily]);

  useEffect(() => {
    if (selectedVersionId === null) return;
    let cancelled = false;

    setStatus('loading');
    client
      .getTaxonomyVersion(selectedVersionId)
      .then((detail) => {
        if (cancelled) return;
        setVersion(detail);
        setSelectedNode(null);
        setPrerequisites(null);
        setExpanded(new Set(detail.nodes.filter((node) => node.parentNodeId === null).map((node) => node.conceptNodeId)));
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [client, selectedVersionId]);

  const childrenOf = useCallback(
    (parentNodeId: string): readonly ConceptNode[] =>
      (version?.nodes ?? []).filter((node) => node.parentNodeId === parentNodeId),
    [version],
  );

  const roots = useMemo(
    () => (version?.nodes ?? []).filter((node) => node.parentNodeId === null),
    [version],
  );

  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (term === '') return [];
    return (version?.nodes ?? []).filter((node) => node.displayName.toLowerCase().includes(term));
  }, [search, version]);

  const onToggle = useCallback((conceptNodeId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(conceptNodeId)) next.delete(conceptNodeId);
      else next.add(conceptNodeId);
      return next;
    });
  }, []);

  const onSelect = useCallback(
    (node: ConceptNode) => {
      setSelectedNode(node);
      setPrerequisites(null);
      if (selectedVersionId === null) return;
      client
        .getConceptPrerequisites(selectedVersionId, node.conceptIdentityId)
        .then(setPrerequisites)
        .catch(() => setPrerequisites(null));
    },
    [client, selectedVersionId],
  );

  const selectedVersion = versions.find((candidate) => candidate.taxonomyVersionId === selectedVersionId);

  return (
    <main>
      <h1>Taxonomy browser</h1>

      <label htmlFor="version-selector">Taxonomy version</label>
      <select
        id="version-selector"
        value={selectedVersionId ?? ''}
        onChange={(event) => setSelectedVersionId(event.target.value)}
      >
        {versions.map((candidate) => (
          <option key={candidate.taxonomyVersionId} value={candidate.taxonomyVersionId}>
            {candidate.examFamily} {candidate.academicYear} ({candidate.state})
          </option>
        ))}
      </select>

      {selectedVersion?.state === 'published' ? (
        <p role="status">Published — read only. Create a draft to make changes.</p>
      ) : null}

      <label htmlFor="concept-search">Search concepts</label>
      <input
        id="concept-search"
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />

      {status === 'loading' ? <p role="status">Loading…</p> : null}
      {status === 'error' ? (
        <p role="alert">The taxonomy could not be loaded. Try again.</p>
      ) : null}

      {status === 'ready' && version !== null && version.nodes.length === 0 ? (
        <p role="status">This version has no concepts yet.</p>
      ) : null}

      {search.trim() !== '' ? (
        <section aria-labelledby="search-results-heading">
          <h2 id="search-results-heading">Search results</h2>
          {matches.length === 0 ? (
            <p role="status">No concept matches “{search}”.</p>
          ) : (
            <ul>
              {matches.map((node) => (
                <li key={node.conceptNodeId}>
                  <button type="button" onClick={() => onSelect(node)}>
                    {node.displayName}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <nav aria-label="Concept tree">
          <ul>
            {roots.map((node) => (
              <TreeNode
                key={node.conceptNodeId}
                node={node}
                childrenOf={childrenOf}
                expanded={expanded}
                onToggle={onToggle}
                onSelect={onSelect}
                selectedNodeId={selectedNode?.conceptNodeId ?? null}
              />
            ))}
          </ul>
        </nav>
      )}

      <section aria-labelledby="concept-detail-heading">
        <h2 id="concept-detail-heading">Concept detail</h2>
        {selectedNode === null ? (
          <p>Select a concept to see its detail.</p>
        ) : (
          <dl>
            <dt>Name</dt>
            <dd>{selectedNode.displayName}</dd>
            <dt>Concept identity</dt>
            <dd>{selectedNode.conceptIdentityId}</dd>
            <dt>Exam weight</dt>
            <dd>{selectedNode.examWeight}</dd>
            <dt>Depth</dt>
            <dd>{selectedNode.depth}</dd>
            <dt>Estimated teaching hours</dt>
            <dd>{selectedNode.estimatedTeachingHours}</dd>
            <dt>Prerequisites</dt>
            <dd>
              {prerequisites === null
                ? '—'
                : prerequisites.requires.length === 0
                  ? 'None'
                  : prerequisites.requires.map((relation) => relation.conceptIdentityId).join(', ')}
            </dd>
            <dt>Items tagged</dt>
            <dd>Not available until content authoring ships</dd>
          </dl>
        )}
      </section>
    </main>
  );
}
