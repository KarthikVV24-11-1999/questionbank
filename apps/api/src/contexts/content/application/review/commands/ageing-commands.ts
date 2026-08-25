/** DEC-M4-15: nothing in M4 is scheduled. `now` is supplied, never read from a clock inside this command. */
export interface SweepReviewAgeing {
  readonly now: string;
}
