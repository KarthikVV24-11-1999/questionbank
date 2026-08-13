/**
 * Stands in for a handler that reached past the typed config module and
 * read `process.env` directly (F16, M0-02). The spec scans this directory
 * as if it were `src/`, so the real allowlist never has to be widened to
 * exercise the rule.
 */
export function readDatabaseUrlDirectly(): string | undefined {
  return process.env['DATABASE_URL'];
}
