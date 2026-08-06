import { useEffect, useState } from 'react';
import type { ExamProfileVersionDetail } from '@questionbank/contracts';
import type { CurriculumClient } from '../taxonomy/curriculum-client.js';
import { describeRule } from './marking-rule-language.js';

export interface ExamProfileViewerProps {
  readonly client: CurriculumClient;
  readonly profileVersionId: string;
  /** Injected so the copy affordance is testable without a real clipboard. */
  readonly copyToClipboard?: (text: string) => Promise<void>;
}

/** Read-only inspection of an exam profile, including its marking rules (M1-34). */
export function ExamProfileViewer({ client, profileVersionId, copyToClipboard }: ExamProfileViewerProps) {
  const [profile, setProfile] = useState<ExamProfileVersionDetail | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    client
      .getExamProfileVersion(profileVersionId)
      .then((found) => {
        if (cancelled) return;
        setProfile(found);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [client, profileVersionId]);

  if (status === 'loading') {
    return (
      <main>
        <h1>Exam profile</h1>
        <p role="status">Loading…</p>
      </main>
    );
  }

  if (status === 'error' || profile === null) {
    return (
      <main>
        <h1>Exam profile</h1>
        <p role="alert">The profile could not be loaded. Try again.</p>
      </main>
    );
  }

  const timing = profile.markingRuleSet;
  void timing;

  return (
    <main>
      <h1>Exam profile</h1>

      {profile.state === 'published' ? (
        <p>Published — read only. Create a new version to make changes.</p>
      ) : null}

      <dl>
        <dt>Academic year</dt>
        <dd>{profile.academicYear}</dd>
        <dt>State</dt>
        <dd>{profile.state}</dd>
        <dt>Total marks</dt>
        <dd>{profile.totalMarks}</dd>
        <dt>Taxonomy version</dt>
        <dd>{profile.taxonomyVersionId}</dd>
      </dl>

      <section aria-labelledby="sections-heading">
        <h2 id="sections-heading">Sections</h2>
        <table>
          <caption>Sections in delivery order</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Name</th>
              <th scope="col">Subject</th>
              <th scope="col">Items</th>
              <th scope="col">Marks</th>
              <th scope="col">Section timing</th>
            </tr>
          </thead>
          <tbody>
            {profile.sections.map((section) => (
              <tr key={section.ordinal}>
                <td>{section.ordinal}</td>
                <td>{section.name}</td>
                <td>{section.subject}</td>
                <td>{section.itemCount}</td>
                <td>{section.maxMarks}</td>
                <td>
                  {section.sectionTimingMinutes === null
                    ? 'Single timer'
                    : `${section.sectionTimingMinutes} minutes`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="allowances-heading">
        <h2 id="allowances-heading">Item type allowances</h2>
        <ul>
          {profile.itemTypeAllowances.map((allowance) => (
            <li key={allowance.itemType}>
              {allowance.itemType} — sections {allowance.sectionOrdinals.join(', ')}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="marking-heading">
        <h2 id="marking-heading">Marking rules</h2>
        <p>Rules are evaluated in order; the first match wins.</p>
        <ol>
          {profile.markingRuleSet.rules.map((rule) => (
            <li key={rule.id}>{describeRule(rule)}</li>
          ))}
        </ol>

        <h3>Rule set hash</h3>
        <p>
          <code>{profile.markingRuleSetHash ?? 'Not yet frozen — this version is a draft.'}</code>
        </p>
        {profile.markingRuleSetHash !== null ? (
          <button
            type="button"
            onClick={() => {
              const copy = copyToClipboard ?? ((text: string) => navigator.clipboard.writeText(text));
              void copy(profile.markingRuleSetHash ?? '').then(() => setCopied(true));
            }}
          >
            Copy rule set hash
          </button>
        ) : null}
        {copied ? <p role="status">Rule set hash copied.</p> : null}
      </section>
    </main>
  );
}
