import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { createApiMetrics } from '../platform/observability/api-metrics.js';

/**
 * What can be asserted of the service level objectives and the alert rules without running anything (M8-55; **Tier 2**, ADR-0013): they are files, and a parse can say they are well formed, that they
 * are the objectives they were rendered from, that the thresholds are the burn rate times the error budget, that every alert names a metric which exists, and that each says where to look. A parse
 * cannot say an alert would fire, that its expression is right for the data, or that anyone would be told; nothing here evaluates a rule, and `docs/M8-ACCEPTANCE.md` criterion 5 stays blocked on that.
 */
export interface ObservabilityViolation {
  readonly rule:
    | 'NOT_LABELLED_TIER_2'
    | 'OBJECTIVE_OUT_OF_RANGE'
    | 'OBJECTIVE_REPEATED'
    | 'BURN_WINDOWS_WRONG'
    | 'ALERTS_NOT_RENDERED_FROM_OBJECTIVES'
    | 'ALERT_MISSING_A_FIELD'
    | 'ALERT_SEVERITY_UNKNOWN'
    | 'ALERT_THRESHOLD_NOT_BURN_TIMES_BUDGET'
    | 'ALERT_NAMES_A_METRIC_THAT_DOES_NOT_EXIST'
    | 'ALERT_RUNBOOK_DOES_NOT_EXIST'
    | 'OBJECTIVE_HAS_NO_BURN_ALERTS'
    | 'RUNBOOK_MISSING_FOR_OBJECTIVE'
    | 'RUNBOOK_ENTRY_INCOMPLETE'
    | 'RUNBOOK_NAMES_A_METRIC_THAT_DOES_NOT_EXIST'
    | 'SEV1_OR_INCIDENT_PLACE_NOT_DEFINED';
  readonly detail: string;
}

interface Slo {
  readonly tier?: number;
  readonly tierNote?: string;
  readonly window?: string;
  readonly burnWindows?: ReadonlyArray<{ readonly long: string; readonly short: string; readonly burn: number; readonly severity: string; readonly for: string }>;
  readonly objectives?: ReadonlyArray<{ readonly id: string; readonly objective: number; readonly errorRatio: string }>;
}
interface Rule {
  readonly alert?: string;
  readonly expr?: string;
  readonly for?: string;
  readonly labels?: Record<string, string>;
  readonly annotations?: Record<string, string>;
}

/** The names the API publishes, with the suffixes a histogram's series carry, and the probe's. */
export async function knownMetrics(root: string): Promise<ReadonlySet<string>> {
  const metrics = createApiMetrics({ pool: { query: async () => ({ rows: [{ depth: '0', oldest_age: null, dead: '0', unconsumed: '0' }] }), totalCount: 0, idleCount: 0, waitingCount: 0 } as never, now: () => new Date(0), rss: () => 0 });
  const page = await metrics.registry.render();
  const names = new Set([...page.matchAll(/^# TYPE (\S+) (\S+)$/gmu)].flatMap((match) => (match[2] === 'histogram' ? [`${match[1]}_bucket`, `${match[1]}_sum`, `${match[1]}_count`] : [match[1]!])));
  for (const found of readFileSync(join(root, 'tools/stack-journey/probe.mjs'), 'utf8').matchAll(/\bqb_probe_[a-z_]+/gu)) names.add(found[0]);
  return names;
}

const headings = (markdown: string): Set<string> => new Set([...markdown.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((m) => m[1]!.trim().toLowerCase().replace(/[^a-z0-9 -]/gu, '').replace(/ /gu, '-')));

export async function checkObservability(
  root: string,
  inputs: { readonly slo?: string; readonly alerts?: string; readonly deployment?: string; readonly render?: (slo: Slo) => string } = {},
): Promise<ObservabilityViolation[]> {
  const violations: ObservabilityViolation[] = [];
  const sloText = inputs.slo ?? readFileSync(join(root, 'infra/observability/slo.json'), 'utf8');
  const alertsText = inputs.alerts ?? readFileSync(join(root, 'infra/observability/alerts.yaml'), 'utf8');
  const deployment = inputs.deployment ?? readFileSync(join(root, 'docs/DEPLOYMENT.md'), 'utf8');
  const slo = JSON.parse(sloText) as Slo;
  // the renderer is the script that makes the file, loaded as it is (it has no types, being a script)
  const render: (slo: Slo) => string = inputs.render ?? ((await import(pathToFileURL(join(root, 'tools/observability/render-alerts.mjs')).href)) as { render: (slo: Slo) => string }).render;

  if (slo.tier !== 2 || !/Tier 2/u.test(slo.tierNote ?? '') || !/nothing pages anyone/u.test(slo.tierNote ?? '') || !/Tier 2/u.test(alertsText.split('\n').slice(0, 4).join('\n'))) {
    violations.push({ rule: 'NOT_LABELLED_TIER_2', detail: 'slo.json and the head of alerts.yaml must say Tier 2 and that nothing pages anyone' });
  }
  const seen = new Set<string>();
  for (const objective of slo.objectives ?? []) {
    if (!(objective.objective > 0 && objective.objective < 1)) violations.push({ rule: 'OBJECTIVE_OUT_OF_RANGE', detail: `${objective.id}: ${objective.objective}` });
    if (seen.has(objective.id)) violations.push({ rule: 'OBJECTIVE_REPEATED', detail: objective.id });
    seen.add(objective.id);
  }
  const windows = slo.burnWindows ?? [];
  const ordered = windows.every((w, i) => i === 0 || (w.burn < (windows[i - 1]?.burn ?? 0)));
  if (windows.length !== 3 || !ordered || windows.some((w) => !['page', 'ticket'].includes(w.severity))) violations.push({ rule: 'BURN_WINDOWS_WRONG', detail: 'three windows, the fastest burn first, each a page or a ticket' });

  if (render(slo) !== alertsText) violations.push({ rule: 'ALERTS_NOT_RENDERED_FROM_OBJECTIVES', detail: 'alerts.yaml is not what slo.json renders to' });

  const parsed = parse(alertsText) as { groups?: Array<{ rules?: Rule[] }> };
  const rules = (parsed.groups ?? []).flatMap((group) => group.rules ?? []);
  const metrics = await knownMetrics(root);
  const anchors = headings(deployment);
  for (const rule of rules) {
    const name = rule.alert ?? '(unnamed)';
    for (const field of ['alert', 'expr', 'for'] as const) if (typeof rule[field] !== 'string' || rule[field] === '') violations.push({ rule: 'ALERT_MISSING_A_FIELD', detail: `${name}: ${field}` });
    for (const field of ['summary', 'description', 'runbook']) if (typeof rule.annotations?.[field] !== 'string' || rule.annotations[field] === '') violations.push({ rule: 'ALERT_MISSING_A_FIELD', detail: `${name}: annotations.${field}` });
    if (!['page', 'ticket'].includes(rule.labels?.['severity'] ?? '')) violations.push({ rule: 'ALERT_SEVERITY_UNKNOWN', detail: `${name}: ${rule.labels?.['severity']}` });
    for (const used of new Set((rule.expr ?? '').match(/\bqb_[a-z0-9_]+/gu) ?? [])) {
      if (!metrics.has(used)) violations.push({ rule: 'ALERT_NAMES_A_METRIC_THAT_DOES_NOT_EXIST', detail: `${name}: ${used}` });
    }
    const runbook = rule.annotations?.['runbook'] ?? '';
    const anchor = /^docs\/DEPLOYMENT\.md#(.+)$/u.exec(runbook)?.[1];
    if (anchor === undefined || !anchors.has(anchor)) violations.push({ rule: 'ALERT_RUNBOOK_DOES_NOT_EXIST', detail: `${name}: ${runbook}` });
  }
  // The runbook (M8-59): each objective has an entry with its three parts, and every metric the words name is on the page. Whether the words are right cannot be tested; that they are there, complete and name real things can.
  const section = /^### What a page means$([\s\S]*?)(?=^## )/mu.exec(deployment)?.[1] ?? '';
  const entries = new Map([...section.matchAll(/^#### Runbook: (\S+)$([\s\S]*?)(?=^#{1,4} |(?![\s\S]))/gmu)].map((m) => [m[1]!, m[2]!]));
  for (const objective of slo.objectives ?? []) {
    const entry = entries.get(objective.id);
    if (entry === undefined) {
      violations.push({ rule: 'RUNBOOK_MISSING_FOR_OBJECTIVE', detail: objective.id });
      continue;
    }
    const look = /\*\*Look at first\.\*\*([^\n]*)/u.exec(entry)?.[1] ?? '';
    const complete = entry.includes('**What a page means.**') && entry.includes('**A false alarm when**') && look !== '' && [1, 2, 3].every((n) => look.includes(`(${n})`));
    if (!complete) violations.push({ rule: 'RUNBOOK_ENTRY_INCOMPLETE', detail: objective.id });
  }
  for (const used of new Set(section.match(/\bqb_[a-z0-9_]+/gu) ?? [])) {
    if (!metrics.has(used)) violations.push({ rule: 'RUNBOOK_NAMES_A_METRIC_THAT_DOES_NOT_EXIST', detail: used });
  }
  const sev1 = /^### Sev-1$([\s\S]*?)(?=^## |(?![\s\S]))/mu.exec(deployment)?.[1] ?? '';
  if (!sev1.includes('A **Sev-1** for this product is') || !sev1.includes('Where an incident is written')) violations.push({ rule: 'SEV1_OR_INCIDENT_PLACE_NOT_DEFINED', detail: 'the "Sev-1" section must define it and say where an incident is written' });
  for (const objective of slo.objectives ?? []) {
    for (const window of windows) {
      const rule = rules.find((r) => r.alert === `SloBurn_${objective.id.replaceAll('-', '_')}_${window.long}`);
      if (rule === undefined) {
        violations.push({ rule: 'OBJECTIVE_HAS_NO_BURN_ALERTS', detail: `${objective.id} over ${window.long}` });
        continue;
      }
      const expected = Math.round(window.burn * (1 - objective.objective) * 1e9) / 1e9;
      const limits = [...(rule.expr ?? '').matchAll(/\) > ([0-9.]+)/gu)].map((m) => Number(m[1]));
      if (limits.length !== 2 || limits.some((limit) => limit !== expected)) violations.push({ rule: 'ALERT_THRESHOLD_NOT_BURN_TIMES_BUDGET', detail: `${rule.alert}: ${limits.join(', ')} is not ${expected}` });
      if (rule.labels?.['severity'] !== window.severity || rule.for !== window.for) violations.push({ rule: 'ALERT_THRESHOLD_NOT_BURN_TIMES_BUDGET', detail: `${rule.alert}: severity or duration differs from its window` });
    }
  }
  return violations;
}
