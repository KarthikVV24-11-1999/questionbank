import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkObservability, knownMetrics } from './observability-rules.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (file: string): string => readFileSync(resolve(ROOT, file), 'utf8');
const SLO = read('infra/observability/slo.json');
const ALERTS = read('infra/observability/alerts.yaml');
const rules = async (over: Parameters<typeof checkObservability>[1]): Promise<string[]> => [...new Set((await checkObservability(ROOT, over)).map((v) => v.rule))].sort();

describe('the objectives and the alert rules (Tier 2: parsed and asserted, never evaluated)', () => {
  it('are well formed, are what the objectives render to, and break none of the rules below', async () => {
    expect(await checkObservability(ROOT)).toEqual([]);
  });

  it('know the metrics the API publishes and the probe writes, with a histogram\'s suffixes', async () => {
    const known = await knownMetrics(ROOT);
    for (const name of ['qb_http_requests_total', 'qb_http_request_duration_seconds_bucket', 'qb_http_request_duration_seconds_count', 'qb_outbox_oldest_unrelayed_age_seconds', 'qb_probe_success', 'qb_probe_last_run_timestamp_seconds']) expect(known.has(name), name).toBe(true);
    expect(known.has('qb_http_request_duration_seconds')).toBe(false);
  });

  it('cover every objective with the three burn rates, and the two absences', () => {
    const names = [...ALERTS.matchAll(/- alert: (\S+)/gu)].map((m) => m[1]);
    const objectives = (JSON.parse(SLO) as { objectives: unknown[] }).objectives.length;
    expect(names).toHaveLength(objectives * 3 + 2);
    expect(names).toContain('MetricsAbsent');
    expect(names).toContain('ProbeAbsent');
    expect(names).toContain('SloBurn_availability_1h');
  });
});

describe('planted: each rule can fail', () => {
  it('a thing not labelled Tier 2, or not saying nothing pages anyone', async () => {
    expect(await rules({ slo: SLO.replace('"tier": 2', '"tier": 1') })).toContain('NOT_LABELLED_TIER_2');
    expect(await rules({ slo: SLO.replace('nothing pages anyone', 'it pages the owner') })).toContain('NOT_LABELLED_TIER_2');
    expect(await rules({ alerts: ALERTS.replace('Tier 2', 'Tier 1') })).toContain('NOT_LABELLED_TIER_2');
  });

  it('an objective of 100%, of 0, or listed twice', async () => {
    expect(await rules({ slo: SLO.replace('"objective": 0.995', '"objective": 1') })).toContain('OBJECTIVE_OUT_OF_RANGE');
    expect(await rules({ slo: SLO.replace('"objective": 0.995', '"objective": 0') })).toContain('OBJECTIVE_OUT_OF_RANGE');
    expect(await rules({ slo: SLO.replaceAll('"id": "probe"', '"id": "availability"') })).toContain('OBJECTIVE_REPEATED');
  });

  it('burn windows that are not three, not in falling order, or neither a page nor a ticket', async () => {
    expect(await rules({ slo: SLO.replace('"burn": 6,', '"burn": 20,') })).toContain('BURN_WINDOWS_WRONG');
    expect(await rules({ slo: SLO.replace('"severity": "ticket"', '"severity": "email"') })).toContain('BURN_WINDOWS_WRONG');
    const two = JSON.parse(SLO) as { burnWindows: unknown[] };
    two.burnWindows.pop();
    expect(await rules({ slo: JSON.stringify(two) })).toContain('BURN_WINDOWS_WRONG');
  });

  it('an alerts file that is not what the objectives render to: edited by hand, or an objective changed without rendering', async () => {
    expect(await rules({ alerts: ALERTS.replace('for: 2m', 'for: 3m') })).toContain('ALERTS_NOT_RENDERED_FROM_OBJECTIVES');
    expect(await rules({ slo: SLO.replace('"objective": 0.995', '"objective": 0.99') })).toContain('ALERTS_NOT_RENDERED_FROM_OBJECTIVES');
  });

  it('a threshold that is not the burn times the budget, in the expression or in the severity and duration', async () => {
    const tampered = ALERTS.replace('> 0.072 and', '> 0.07 and');
    expect(await rules({ alerts: tampered, render: () => tampered })).toContain('ALERT_THRESHOLD_NOT_BURN_TIMES_BUDGET');
    const slower = ALERTS.replace('for: 2m', 'for: 9m');
    expect(await rules({ alerts: slower, render: () => slower })).toContain('ALERT_THRESHOLD_NOT_BURN_TIMES_BUDGET');
    const quieter = ALERTS.replace('severity: "page"', 'severity: "ticket"');
    expect(await rules({ alerts: quieter, render: () => quieter })).toContain('ALERT_THRESHOLD_NOT_BURN_TIMES_BUDGET');
  });

  it('an alert over a metric that does not exist: a rename that left the rule behind', async () => {
    const renamed = ALERTS.replace('qb_outbox_depth', 'qb_outbox_backlog');
    const violations = await checkObservability(ROOT, { alerts: renamed, render: () => renamed });
    expect(violations).toContainEqual({ rule: 'ALERT_NAMES_A_METRIC_THAT_DOES_NOT_EXIST', detail: 'MetricsAbsent: qb_outbox_backlog' });
    const bucket = ALERTS.replaceAll('qb_http_request_duration_seconds_bucket', 'qb_http_request_duration_seconds');
    expect((await checkObservability(ROOT, { alerts: bucket, render: () => bucket })).map((v) => v.rule)).toContain('ALERT_NAMES_A_METRIC_THAT_DOES_NOT_EXIST');
  });

  it('an alert with a field missing, an unknown severity, or a runbook that does not exist', async () => {
    const edit = async (from: string, to: string) => {
      const alerts = ALERTS.replace(from, to);
      return rules({ alerts, render: () => alerts });
    };
    expect(await edit('        for: 2m\n', '')).toContain('ALERT_MISSING_A_FIELD');
    expect(await edit('summary: "The API', 'sommary: "The API')).toContain('ALERT_MISSING_A_FIELD');
    expect(await edit('description: "Either the scraper', 'descripton: "Either the scraper')).toContain('ALERT_MISSING_A_FIELD');
    expect(await edit('severity: "ticket"', 'severity: "whenever"')).toContain('ALERT_SEVERITY_UNKNOWN');
    expect(await edit('docs/DEPLOYMENT.md#watching-it', 'docs/DEPLOYMENT.md#nowhere')).toContain('ALERT_RUNBOOK_DOES_NOT_EXIST');
    expect(await edit('docs/DEPLOYMENT.md#watching-it', 'docs/RUNBOOK.md')).toContain('ALERT_RUNBOOK_DOES_NOT_EXIST');
  });

  it('an objective with no burn alert', async () => {
    const alerts = ALERTS.replace(/      - alert: SloBurn_probe_6h[\s\S]*?(?=      - alert: )/u, '');
    const violations = await checkObservability(ROOT, { alerts, render: () => alerts });
    expect(violations).toContainEqual({ rule: 'OBJECTIVE_HAS_NO_BURN_ALERTS', detail: 'probe over 6h' });
  });
});
