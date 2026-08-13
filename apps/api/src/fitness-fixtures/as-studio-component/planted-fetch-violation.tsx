// Planted violation for frontend-rules.spec.ts (F15): a component calling
// fetch() directly, exactly the shape M0-17's typed client exists to
// replace.
export async function loadItems(): Promise<unknown> {
  const response = await fetch('/v1/authoring/drafts');
  return response.json();
}
