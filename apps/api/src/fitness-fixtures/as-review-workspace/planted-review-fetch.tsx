// Planted violation for frontend-rules.spec.ts (F15), M4-42's own row.
//
// The existing F15 fixture (`as-studio-component/planted-fetch-violation.tsx`)
// proves the rule fires; this one proves the rule's *subject* now includes the
// review workspace. M4-38 added a feature whose whole job is talking to the
// API on a hot path, and a reviewer's screen reaching for `fetch` directly is
// the exact shape F15 exists to refuse — it skips the client that carries the
// bearer token, the correlation ID and the response-schema validation.
//
// The path this plants is the one the workspace does NOT have: a bespoke
// "next" endpoint invented at the component instead of the claim command
// M4-27 already owns.
export async function claimNextItem(): Promise<unknown> {
  const response = await fetch('/v1/authoring/review/next');
  return response.json();
}
