import {
  createAttempt,
  type Attempt,
  type AttemptError,
  type AttemptSlot,
  type CreateAttemptProps,
} from './attempt.js';
import {
  preconditionFailedError,
  ruleViolationError,
  validationError,
  type AssessmentError,
} from './assessment-error.js';
import { freezeJson, isJsonObject } from './json-document.js';
import { err, ok, type Result } from './result.js';
import { isFrozen, transition, FORM_STATES, type FormState, type FormTrigger } from './form-state.js';
import { isNonBlank, isSessionRef, isPositiveInteger, isUtcTimestamp, isUuid } from './uuid.js';

/**
 * `Form` — a fixed, pre-assembled examination paper (DOMAIN-MODEL §6).
 *
 * **It pins versions, not items.** Every slot names the exact `itemVersionId`
 * (and stimulus version) it presents. That pin is what makes INV-04 real: an
 * attempt copies it, and a response records it, so a later edit to an item
 * can never change what an old attempt was scored against.
 *
 * **Draft until published, then immutable (D-006).** While a form is a draft
 * its slots may be substituted; publication freezes the composition for good.
 * Immutability begins at publication, not at the first attempt — the earlier
 * boundary is simpler and removes a race between the two. Every operation that
 * changes composition refuses a published form, and the database refuses the
 * same writes by trigger.
 *
 * ASSESSMENT-ENGINE §12 lists what must be captured from the first attempt and
 * cannot be rebuilt. Where each lives, and what cannot be null:
 *
 *  - **anchor items in every form** — `FormSlot.isAnchor`, a boolean on every
 *    slot (never absent), and publication refuses a form where fewer than 15%
 *    of the slots are anchors from the anchor pool (F50);
 *  - **per-item exposure with form and session identity** — a slot here gives
 *    the form identity and the item version; the attempt gives the session.
 *    The ledger that aggregates them is form assembly's;
 *  - **per-item response timing**, **the answer-change sequence** and
 *    **the item version pinned per response** — `ResponseEvent`;
 *  - **attempt-level session and shift** — `Attempt`;
 *  - **ability estimates per step** — practice attempts only (H1), so there is
 *    nothing in a form to hold.
 *
 * Form *states* beyond `draft` and `published` (embargoed, active, closed) and
 * its schedule window belong to scheduling; a state joins this list the day
 * something constructs it.
 */
export const FORM_TYPES = ['mock', 'diagnostic'] as const;
export type FormType = (typeof FORM_TYPES)[number];

export { FORM_STATES, FORM_TRIGGERS, type FormState, type FormTrigger } from './form-state.js';

/** F50: a published form is at least this share anchor items (ASSESSMENT-ENGINE §6, §10). */
export const MINIMUM_ANCHOR_PERCENT = 15;

export interface FormSlot {
  readonly slotId: string;
  readonly ordinal: number;
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly stimulusVersionId: string | null;
  readonly marksAvailable: number;
  /** §12: whether this item is drawn from the anchor pool. Present on every slot. */
  readonly isAnchor: boolean;
}

export interface FormSection {
  readonly ordinal: number;
  /** The section of the exam profile this section satisfies. */
  readonly sectionSpecRef: string;
  readonly slots: readonly FormSlot[];
}

export interface Form {
  readonly formId: string;
  readonly examProfileVersionId: string;
  readonly formType: FormType;
  /**
   * The sittings this form is published for (ADR-0032). A session is a named
   * sitting and its identity is this canonical key; the form is where it is
   * declared. The exposure ledger holds a row per slot per session, and an
   * attempt's session must be one of these — by a foreign key, so it *is* one
   * and does not merely agree. Sorted, so the same sittings are the same form.
   * Server-side fact, fixed when the form is created. Every session shares the
   * form's window (D56).
   */
  readonly sessionRefs: readonly string[];
  /**
   * How the composition measures against the profile blueprint. A JSON object
   * with a boolean `satisfied`; the rest is form assembly's to define, and an
   * older report must stay readable (hence the schema version the table keeps).
   */
  readonly blueprintConformance: Readonly<Record<string, unknown>>;
  readonly state: FormState;
  readonly publishedAt: string | null;
  /**
   * When attempts may be sat: set when the form is scheduled and fixed from
   * then on. **Server-side fact** — an operator schedules it, the database
   * holds it, and an attempt's own window is copied from it (and checked
   * against it by a key), so nothing a client sends can move it.
   */
  readonly scheduleWindow: ScheduleWindow | null;
  readonly sections: readonly FormSection[];
}

export interface ScheduleWindow {
  readonly opensAt: string;
  readonly closesAt: string;
}

export type FormErrorCode =
  | 'FORM_ID_INVALID'
  | 'FORM_PROFILE_INVALID'
  | 'FORM_TYPE_INVALID'
  | 'FORM_SESSIONS_INVALID'
  | 'FORM_SESSION_NOT_PUBLISHED_FOR'
  | 'FORM_CONFORMANCE_INVALID'
  | 'FORM_SECTIONS_INVALID'
  | 'FORM_SLOT_INVALID'
  | 'FORM_SLOT_NOT_FOUND'
  | 'FORM_NOW_INVALID'
  | 'FORM_IS_PUBLISHED'
  | 'FORM_NOT_CONFORMING'
  | 'FORM_ANCHOR_SHARE_TOO_LOW'
  | 'FORM_ANCHOR_FLAG_DISAGREES_WITH_POOL'
  | 'FORM_NOT_PUBLISHED'
  | 'FORM_STORED_STATE_INVALID'
  | 'FORM_TRANSITION_PROHIBITED'
  | 'FORM_WINDOW_INVALID'
  | 'FORM_WINDOW_NOT_YET_OPEN'
  | 'FORM_WINDOW_STILL_OPEN'
  | 'FORM_NOT_OPEN_FOR_ATTEMPTS'
  | 'FORM_WINDOW_CLOSED';

export type FormError = AssessmentError<FormErrorCode>;

export interface CreateFormProps {
  readonly formId: string;
  readonly examProfileVersionId: string;
  readonly formType: FormType;
  readonly sessionRefs: readonly string[];
  readonly blueprintConformance: Readonly<Record<string, unknown>>;
  readonly sections: readonly FormSection[];
}

function invalid(code: FormErrorCode, message: string, location: string): FormError {
  return validationError(code, message, location);
}

function slotFault(slot: FormSlot): string | null {
  if (!isUuid(slot.slotId) || !isUuid(slot.itemId) || !isUuid(slot.itemVersionId)) {
    return 'a slot needs a uuid slot id, item id and item version id';
  }
  if (slot.stimulusVersionId !== null && !isUuid(slot.stimulusVersionId)) return 'a stimulus version is a uuid or absent';
  if (!Number.isSafeInteger(slot.ordinal) || slot.ordinal < 0) return 'a slot ordinal is a non-negative whole number';
  if (!isPositiveInteger(slot.marksAvailable)) return 'marksAvailable is a positive whole number';
  if (typeof slot.isAnchor !== 'boolean') return 'every slot says whether it is an anchor item (§12)';
  return null;
}

function sectionsFault(sections: readonly FormSection[]): { code: FormErrorCode; message: string } | null {
  if (!Array.isArray(sections) || sections.length === 0) return { code: 'FORM_SECTIONS_INVALID', message: 'a form has at least one section' };
  const sectionOrdinals = new Set<number>();
  const slotIds = new Set<string>();
  const slotOrdinals = new Set<number>();
  const itemIds = new Set<string>();
  let slotCount = 0;
  for (const section of sections) {
    if (!Number.isSafeInteger(section.ordinal) || section.ordinal < 0 || !isNonBlank(section.sectionSpecRef)) {
      return { code: 'FORM_SECTIONS_INVALID', message: 'a section needs an ordinal and the profile section it satisfies' };
    }
    if (!Array.isArray(section.slots) || section.slots.length === 0) {
      return { code: 'FORM_SECTIONS_INVALID', message: 'a section has at least one slot' };
    }
    sectionOrdinals.add(section.ordinal);
    for (const slot of section.slots) {
      const fault = slotFault(slot);
      if (fault !== null) return { code: 'FORM_SLOT_INVALID', message: fault };
      slotIds.add(slot.slotId);
      slotOrdinals.add(slot.ordinal);
      itemIds.add(slot.itemId);
      slotCount += 1;
    }
  }
  if (sectionOrdinals.size !== sections.length) return { code: 'FORM_SECTIONS_INVALID', message: 'section ordinals must be distinct' };
  if (slotIds.size !== slotCount) return { code: 'FORM_SLOT_INVALID', message: 'slot ids must be distinct' };
  if (slotOrdinals.size !== slotCount) return { code: 'FORM_SLOT_INVALID', message: 'slot ordinals must be distinct across the form' };
  if (itemIds.size !== slotCount) return { code: 'FORM_SLOT_INVALID', message: 'an item appears in a form once' };
  return null;
}

function freezeSections(sections: readonly FormSection[]): readonly FormSection[] {
  return Object.freeze(
    [...sections]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((section) =>
        Object.freeze({
          ordinal: section.ordinal,
          sectionSpecRef: section.sectionSpecRef,
          slots: Object.freeze([...section.slots].sort((a, b) => a.ordinal - b.ordinal).map((slot) => Object.freeze({ ...slot }))),
        }),
      ),
  );
}

/** A new form is a draft. */
export function createForm(props: CreateFormProps): Result<Form, FormError> {
  if (!isUuid(props.formId)) return err(invalid('FORM_ID_INVALID', 'formId must be a uuid', 'formId'));
  if (!isUuid(props.examProfileVersionId)) {
    return err(invalid('FORM_PROFILE_INVALID', 'examProfileVersionId must be a uuid', 'examProfileVersionId'));
  }
  if (!(FORM_TYPES as readonly string[]).includes(props.formType)) {
    return err(invalid('FORM_TYPE_INVALID', 'formType is mock or diagnostic', 'formType'));
  }
  if (!Array.isArray(props.sessionRefs) || props.sessionRefs.length === 0 || !props.sessionRefs.every(isSessionRef) || new Set(props.sessionRefs).size !== props.sessionRefs.length) {
    return err(invalid('FORM_SESSIONS_INVALID', 'a form names the sessions it is published for: one or more, each a distinct canonical key (ADR-0032)', 'sessionRefs'));
  }
  if (!isJsonObject(props.blueprintConformance) || typeof props.blueprintConformance['satisfied'] !== 'boolean') {
    return err(invalid('FORM_CONFORMANCE_INVALID', 'blueprintConformance is an object with a boolean `satisfied`', 'blueprintConformance'));
  }
  const fault = sectionsFault(props.sections);
  if (fault !== null) return err(invalid(fault.code, fault.message, 'sections'));

  return ok(
    Object.freeze({
      formId: props.formId,
      examProfileVersionId: props.examProfileVersionId,
      formType: props.formType,
      sessionRefs: Object.freeze([...props.sessionRefs].sort()),
      blueprintConformance: freezeJson({ ...props.blueprintConformance }),
      state: 'draft' as const,
      publishedAt: null,
      scheduleWindow: null,
      sections: freezeSections(props.sections),
    }),
  );
}

function refusePublished(form: Form): FormError | null {
  return isFrozen(form.state)
    ? ruleViolationError('FORM_IS_PUBLISHED', 'a published form is immutable; substitution is a draft-state operation only (D-006)', 'state')
    : null;
}

/** All of a form's slots, in section then slot order. */
export function slotsOf(form: Form): readonly FormSlot[] {
  return form.sections.flatMap((section) => section.slots);
}

/**
 * Replaces the item in one slot — draft only (D-006). The slot keeps its place
 * and its marks; the item, its version and its anchor status are the new one's.
 */
export function substituteSlot(
  form: Form,
  slotId: string,
  replacement: Pick<FormSlot, 'itemId' | 'itemVersionId' | 'stimulusVersionId' | 'isAnchor'>,
): Result<Form, FormError> {
  const refused = refusePublished(form);
  if (refused !== null) return err(refused);
  if (!slotsOf(form).some((slot) => slot.slotId === slotId)) {
    return err(invalid('FORM_SLOT_NOT_FOUND', 'the form has no such slot', 'slotId'));
  }
  return createForm({
    formId: form.formId,
    examProfileVersionId: form.examProfileVersionId,
    formType: form.formType,
    sessionRefs: form.sessionRefs,
    blueprintConformance: form.blueprintConformance,
    sections: form.sections.map((section) => ({
      ...section,
      slots: section.slots.map((slot) => (slot.slotId === slotId ? { ...slot, ...replacement } : slot)),
    })),
  });
}

/**
 * F50's arithmetic, in one place: at least `MINIMUM_ANCHOR_PERCENT` of the slots
 * are anchors, compared in whole numbers so no rounding can turn a miss into a
 * pass. The database holds the same rule as `assessment.anchor_floor_met`, and
 * a spec holds the two to the same answer over a grid of forms.
 */
export function meetsAnchorFloor(anchors: number, total: number): boolean {
  return total > 0 && anchors * 100 >= total * MINIMUM_ANCHOR_PERCENT;
}

/** F50 — the share of slots that are anchor items, as a whole percentage rounded down. */
export function anchorPercent(form: Form): number {
  const slots = slotsOf(form);
  return Math.floor((slots.filter((slot) => slot.isAnchor).length * 100) / slots.length);
}

/**
 * Publishes a draft, freezing it.
 *
 * **The anchor check is made against the pool, not against the form's own
 * say-so.** A slot's `isAnchor` flag is a claim by whoever composed the form;
 * what makes an item an anchor is membership of the pool at the moment of
 * publication. So the flag must agree with the pool in both directions — a
 * slot claiming to be an anchor that is not in the pool, and a pool member
 * left unflagged, are each refused, because either would put the wrong number
 * into every later equating — and the 15% floor (F50) is then counted over the
 * pool's own members. A form below it is refused here, not warned about: one
 * published without anchors can never be equated to anything (§10).
 */
export function publishForm(form: Form, now: string, activeAnchors: ReadonlySet<string>): Result<Form, FormError> {
  if (!isUtcTimestamp(now)) return err(invalid('FORM_NOW_INVALID', 'now must be a UTC timestamp with milliseconds', 'now'));
  const refused = refusePublished(form);
  if (refused !== null) return err(refused);
  if (form.blueprintConformance['satisfied'] !== true) {
    return err(preconditionFailedError('FORM_NOT_CONFORMING', 'the form does not satisfy its blueprint', 'blueprintConformance'));
  }
  const slots = slotsOf(form);
  const disagreeing = slots.find((slot) => slot.isAnchor !== activeAnchors.has(slot.itemVersionId));
  if (disagreeing !== undefined) {
    return err(
      preconditionFailedError(
        'FORM_ANCHOR_FLAG_DISAGREES_WITH_POOL',
        `slot ${disagreeing.slotId} is ${disagreeing.isAnchor ? '' : 'not '}flagged an anchor but its item version is ${disagreeing.isAnchor ? 'not ' : ''}in the anchor pool`,
        'sections',
      ),
    );
  }
  const anchors = slots.filter((slot) => slot.isAnchor).length;
  if (!meetsAnchorFloor(anchors, slots.length)) {
    return err(
      preconditionFailedError(
        'FORM_ANCHOR_SHARE_TOO_LOW',
        `a published form is at least ${MINIMUM_ANCHOR_PERCENT}% anchor items; this one is ${anchorPercent(form)}% (F50)`,
        'sections',
      ),
    );
  }
  return ok(Object.freeze({ ...form, state: 'published' as const, publishedAt: now }));
}

/** The pins an attempt copies from a form (INV-04). */
export function pinSlots(form: Form): readonly AttemptSlot[] {
  return slotsOf(form).map((slot) => ({
    slotId: slot.slotId,
    ordinal: slot.ordinal,
    itemId: slot.itemId,
    itemVersionId: slot.itemVersionId,
    stimulusVersionId: slot.stimulusVersionId,
  }));
}

export type AttemptFromFormProps = Omit<CreateAttemptProps, 'mode' | 'formId' | 'examProfileVersionId' | 'slots' | 'windowClosesAt'>;

/**
 * Creates an attempt against a form that is open: `active`, with `now` inside
 * its window. The form supplies the mode, its identity, the profile version,
 * every slot's pinned version **and the attempt's window**, so the window an
 * attempt is held to is the form's and not anything a caller passed.
 *
 * Both the state and the clock are asked, on purpose. The state is a record
 * that something opened the form, and the sweep that opens and closes windows
 * runs on an interval (D36), so the state can lag by one; the clock is the truth the
 * window means. An attempt needs both to agree.
 */
export function createAttemptFromForm(form: Form, props: AttemptFromFormProps, now: string): Result<Attempt, FormError | AttemptError> {
  if (!isUtcTimestamp(now)) return err(invalid('FORM_NOW_INVALID', 'now must be a UTC timestamp with milliseconds', 'now'));
  if (form.state !== 'active' || form.scheduleWindow === null) {
    return err(preconditionFailedError('FORM_NOT_OPEN_FOR_ATTEMPTS', `an attempt is created against an active form; this one is ${form.state}`, 'formId'));
  }
  if (now >= form.scheduleWindow.closesAt || now < form.scheduleWindow.opensAt) {
    return err(
      preconditionFailedError(
        now < form.scheduleWindow.opensAt ? 'FORM_WINDOW_NOT_YET_OPEN' : 'FORM_WINDOW_CLOSED',
        'the form\'s window is not open at this moment',
        'scheduleWindow',
      ),
    );
  }
  if (!form.sessionRefs.includes(props.sessionRef)) {
    return err(preconditionFailedError('FORM_SESSION_NOT_PUBLISHED_FOR', 'the form was not published for that session', 'sessionRef'));
  }
  return createAttempt({
    ...props,
    mode: form.formType,
    formId: form.formId,
    examProfileVersionId: form.examProfileVersionId,
    slots: pinSlots(form),
    windowClosesAt: form.scheduleWindow.closesAt,
  });
}

function prohibited(form: Form, trigger: FormTrigger): FormError {
  return ruleViolationError('FORM_TRANSITION_PROHIBITED', `a ${form.state} form cannot ${trigger}`, 'state');
}

/**
 * Gives a published form its window and seals it until the window opens. The
 * window is a fact about the sitting and is supplied by whoever schedules it;
 * it must end after it starts, and cannot already be over.
 */
export function scheduleForm(form: Form, window: ScheduleWindow, now: string): Result<Form, FormError> {
  if (!isUtcTimestamp(now)) return err(invalid('FORM_NOW_INVALID', 'now must be a UTC timestamp with milliseconds', 'now'));
  const next = transition(form.state, 'schedule');
  if (next === null) return err(prohibited(form, 'schedule'));
  if (!isUtcTimestamp(window.opensAt) || !isUtcTimestamp(window.closesAt) || window.opensAt >= window.closesAt || window.closesAt <= now) {
    return err(invalid('FORM_WINDOW_INVALID', 'a window starts before it ends, and ends in the future', 'scheduleWindow'));
  }
  return ok(Object.freeze({ ...form, state: next, scheduleWindow: Object.freeze({ opensAt: window.opensAt, closesAt: window.closesAt }) }));
}

/** Opens a scheduled form once its window has begun. */
export function openForm(form: Form, now: string): Result<Form, FormError> {
  if (!isUtcTimestamp(now)) return err(invalid('FORM_NOW_INVALID', 'now must be a UTC timestamp with milliseconds', 'now'));
  const next = transition(form.state, 'open');
  if (next === null) return err(prohibited(form, 'open'));
  if (now < (form.scheduleWindow as ScheduleWindow).opensAt) {
    return err(preconditionFailedError('FORM_WINDOW_NOT_YET_OPEN', 'the window has not begun', 'scheduleWindow'));
  }
  return ok(Object.freeze({ ...form, state: next }));
}

/** Closes an open form once its window has ended. */
export function closeForm(form: Form, now: string): Result<Form, FormError> {
  if (!isUtcTimestamp(now)) return err(invalid('FORM_NOW_INVALID', 'now must be a UTC timestamp with milliseconds', 'now'));
  const next = transition(form.state, 'close');
  if (next === null) return err(prohibited(form, 'close'));
  if (now < (form.scheduleWindow as ScheduleWindow).closesAt) {
    return err(preconditionFailedError('FORM_WINDOW_STILL_OPEN', 'the window has not ended', 'scheduleWindow'));
  }
  return ok(Object.freeze({ ...form, state: next }));
}

export interface FormSnapshot extends CreateFormProps {
  readonly state: FormState;
  readonly publishedAt: string | null;
  readonly scheduleWindow: ScheduleWindow | null;
}

/**
 * Rebuilds a form from storage: validated as creation is, with the state and
 * publication time it was stored under. Publication's own rules (anchor share,
 * conformance) are not re-run — they governed how it got here, and a form
 * published under an earlier rule is still the form its attempts were sat on.
 */
export function restoreForm(snapshot: FormSnapshot): Result<Form, FormError> {
  const created = createForm(snapshot);
  if (!created.ok) return created;
  const window = snapshot.scheduleWindow;
  const scheduled = snapshot.state === 'embargoed' || snapshot.state === 'active' || snapshot.state === 'closed';
  const consistent =
    (FORM_STATES as readonly string[]).includes(snapshot.state) &&
    (snapshot.state !== 'draft') === (snapshot.publishedAt !== null) &&
    (snapshot.publishedAt === null || isUtcTimestamp(snapshot.publishedAt)) &&
    scheduled === (window !== null) &&
    (window === null || (isUtcTimestamp(window.opensAt) && isUtcTimestamp(window.closesAt) && window.opensAt < window.closesAt));
  if (!consistent) {
    return err(invalid('FORM_STORED_STATE_INVALID', 'the stored state, publication time and window do not agree', 'state'));
  }
  return ok(
    Object.freeze({
      ...created.value,
      state: snapshot.state,
      publishedAt: snapshot.publishedAt,
      scheduleWindow: window === null ? null : Object.freeze({ opensAt: window.opensAt, closesAt: window.closesAt }),
    }),
  );
}
