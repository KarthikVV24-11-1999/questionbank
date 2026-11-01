/**
 * The identity context's public surface (ENGINEERING-HANDBOOK §1). Nothing is offered to other contexts: identity is reached by the composition root alone, through
 * `composition.ts`, and what the rest of the application receives from it is a `PrincipalResolver`, the port each context already declares for itself.
 */
export {};
