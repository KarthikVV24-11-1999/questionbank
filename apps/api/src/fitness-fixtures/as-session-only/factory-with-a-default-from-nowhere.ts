/** Planted: a root that writes the default but never builds the identity resolver it names. */
declare const identity: { resolver: unknown };
export const principals = (overrides: { principals?: unknown }) => overrides.principals ?? identity.resolver;
