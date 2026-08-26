import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { HandlerRegistry } from '../application/handler-registry.js';
import {
  CONTENT_PRINCIPAL_RESOLVER,
  CONTENT_REGISTRY,
  runOperation,
  type PrincipalResolver,
} from './http-runner.js';
import {
  approveWithEditsSchema,
  assignmentIdSchema,
  claimNextForReviewSchema,
  getQueueHealthSchema,
  getReviewerThroughputSchema,
  itemVersionIdSchema,
  reassignReviewSchema,
} from './dto/review-schemas.js';

/**
 * The review workspace's HTTP surface (DEC-M4-7, DEC-M4-12, M4-37).
 *
 * Mounts under `/v1/authoring/review/**` — the enumerated, key-bearing prefix
 * ADR-0009 already closes over `/v1/authoring/**`, so a review screen showing
 * an answer key needs no amendment to that enumeration.
 *
 * **Not classified as review-side plumbing by the M4-01 sub-boundary gate**
 * (amended 2026-08-26, see `content-rules.ts`'s dated note on
 * `REVIEW_PATH_SEGMENT`) — this file translates HTTP to a command and a
 * `Result` back to a status code, the same job `authoring.controller.ts` and
 * `content.controller.ts` already do, and it imports `http-runner.ts` the
 * same way they do. Controllers translate and delegate: parse, authenticate,
 * resolve the handler, map the typed result onto a status. No business rule
 * lives here and no authorization decision either — that stays at the
 * handler, where a background worker also passes.
 *
 * `SweepReviewAgeing` and `RefreshFingerprints` have no route here — DEC-M4-15:
 * nothing in M4 is scheduled, and neither is a reviewer-facing action.
 */
@Controller()
export class ReviewController {
  constructor(
    @Inject(CONTENT_REGISTRY) private readonly registry: HandlerRegistry,
    @Inject(CONTENT_PRINCIPAL_RESOLVER) private readonly principals: PrincipalResolver,
  ) {}

  private get deps() {
    return { registry: this.registry, principals: this.principals };
  }

  // ── Assignment (DEC-M4-9) ────────────────────────────────────────────────

  @Post('/v1/authoring/review/assignments')
  async claimNextForReview(@Body() body: unknown, @Headers() headers: Record<string, string>, @Res() response: Response) {
    await runOperation(this.deps, response, headers, 'ClaimNextForReview', 201, claimNextForReviewSchema, body);
  }

  @Post('/v1/authoring/review/assignments/:assignmentId/release')
  async releaseAssignment(
    @Param('assignmentId') assignmentId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'ReleaseAssignment', 200, assignmentIdSchema, { assignmentId });
  }

  @Post('/v1/authoring/review/assignments/:assignmentId/lease-extensions')
  async extendLease(
    @Param('assignmentId') assignmentId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'ExtendLease', 200, assignmentIdSchema, { assignmentId });
  }

  @Post('/v1/authoring/review/item-versions/:itemVersionId/assignment')
  async reassignReview(
    @Param('itemVersionId') itemVersionId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'ReassignReview', 201, reassignReviewSchema, {
      ...body,
      itemVersionId,
    });
  }

  // ── Decision (M4-15, ADR-0018) ───────────────────────────────────────────

  @Post('/v1/authoring/review/items/:itemId/versions/:itemVersionId/approval-with-edits')
  async approveWithEdits(
    @Param('itemId') itemId: string,
    @Param('itemVersionId') itemVersionId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'ApproveWithEdits', 200, approveWithEditsSchema, {
      ...body,
      itemId,
      itemVersionId,
    });
  }

  // ── Duplicate candidates (DEC-M4-2) ──────────────────────────────────────

  @Get('/v1/authoring/review/item-versions/:itemVersionId/duplicate-candidates')
  async getDuplicateCandidates(
    @Param('itemVersionId') itemVersionId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'GetDuplicateCandidates', 200, itemVersionIdSchema, {
      itemVersionId,
    });
  }

  // ── Queue health & throughput (DEC-M4-13) ────────────────────────────────

  @Get('/v1/authoring/review/queue-health')
  async getQueueHealth(@Headers() headers: Record<string, string>, @Res() response: Response) {
    // `now` is the HTTP boundary's own wall-clock read, supplied to a query
    // whose interface takes it as a caller-supplied fact rather than reading
    // one internally (DEC-M4-15) — the same discipline a scheduler firing
    // `SweepReviewAgeing` on the hour would apply, here applied at the
    // moment a live request arrives instead.
    await runOperation(this.deps, response, headers, 'GetQueueHealth', 200, getQueueHealthSchema, {
      now: new Date().toISOString(),
    });
  }

  @Get('/v1/authoring/review/reviewer-throughput')
  async getReviewerThroughput(
    @Query('from') from: string,
    @Query('to') to: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'GetReviewerThroughput', 200, getReviewerThroughputSchema, {
      from,
      to,
    });
  }
}
