/** Planted for `practice-rules.spec.ts` (M8-25): a consumer for runs that reads a form. Never imported by production code. */
interface Deps {
  readonly forms: { findById(id: string): Promise<unknown> };
}
export const readTheForm = (deps: Deps, formId: string) => deps.forms.findById(formId);
