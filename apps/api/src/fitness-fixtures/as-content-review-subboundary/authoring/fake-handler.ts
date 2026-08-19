/**
 * Stands in for anything on the authoring side that is not a domain module
 * and not `application/authorization.ts` — a handler, a query, a repository.
 * `review/` importing this is the violation `planted-reaches-authoring.ts`
 * plants.
 */
export const fakeHandler = 'handler';
