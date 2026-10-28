import type { DiagnosticReportDto, PaceAnalyticsDto, ReviewPlanDto } from '../api/learning-schemas.js';

export const TAXONOMY = '00000000-0000-4000-8000-0000000000d1';
export const PROFILE = '00000000-0000-4000-8000-0000000000e1';
export const concept = (n: number): string => `0000000${n}-0000-4000-8000-00000000c0${n}0`;

export const scheduled = (n: number): ReviewPlanDto['due'][number] => ({
  taxonomyVersionId: TAXONOMY,
  conceptIdentityId: concept(n),
  dueAt: '2026-10-27T10:00:00.000Z',
  intervalDays: 2,
  consecutiveSuccesses: 1,
  lapseCount: 0,
  lastObservedAt: '2026-10-25T10:00:00.000Z',
});

export const escalation = (n: number): ReviewPlanDto['escalated'][number] => ({
  taxonomyVersionId: TAXONOMY,
  conceptIdentityId: concept(n),
  lapseCount: 3,
  escalatedAt: '2026-10-26T10:00:00.000Z',
  remediation: { strategy: 'targeted', taxonomyVersionId: TAXONOMY, conceptIdentityId: concept(n), selected: true },
});

export const plan = (overrides: Partial<ReviewPlanDto> = {}): ReviewPlanDto => ({ asOf: '2026-10-28T10:00:00.000Z', due: [], escalated: [], ...overrides });

export const finding = (rank: number, n: number, marksLost: string): DiagnosticReportDto['findings'][number] => ({
  rank,
  conceptIdentityId: concept(n),
  taxonomyVersionId: TAXONOMY,
  marksLost,
  marksAvailable: '8',
  slots: 2,
  skipped: 0,
  remediation: { strategy: 'targeted', taxonomyVersionId: TAXONOMY, conceptIdentityId: concept(n), selected: rank === 1 },
});

export const report = (overrides: Partial<DiagnosticReportDto> = {}): DiagnosticReportDto => ({
  reportId: '00000000-0000-4000-8000-0000000000a1',
  attemptId: 'att-1',
  scoreRecordId: 'score-1',
  generatedAt: '2026-10-28T10:00:00.000Z',
  findings: [finding(1, 1, '9'), finding(2, 2, '5')],
  ...overrides,
});

export const pace = (overrides: Partial<PaceAnalyticsDto> = {}): PaceAnalyticsDto => ({
  attemptId: 'att-1',
  slots: [],
  concepts: [{ conceptIdentityId: concept(1), taxonomyVersionId: TAXONOMY, slowCorrect: 1, slowWrong: 2, fastCorrect: 3, fastWrong: 4, unknownCorrect: 5, unknownWrong: 6 }],
  ruleSets: [],
  ...overrides,
});

export const notFound = (): Error => Object.assign(new Error('REPORT_NOT_FOUND'), { problem: { status: 404 } });
export const unreachable = (): Error => new TypeError('Failed to fetch');
