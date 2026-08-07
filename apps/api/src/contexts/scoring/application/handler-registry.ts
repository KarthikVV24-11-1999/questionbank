import type { Result } from '../domain/result.js';
import type { ApplicationContext } from './ports.js';
import type { ApplicationError, AuthorizationPolicy } from './authorization.js';

export interface Handler<TInput, TOutput> {
  readonly name: string;
  readonly policy: AuthorizationPolicy;
  handle(input: TInput, context: ApplicationContext): Promise<Result<TOutput, ApplicationError>>;
}

export class MissingAuthorizationPolicyError extends Error {
  constructor(handlerName: string) {
    super(`handler ${handlerName} declares no authorization policy and cannot be registered`);
    this.name = 'MissingAuthorizationPolicyError';
  }
}

export class DuplicateHandlerError extends Error {
  constructor(handlerName: string) {
    super(`handler ${handlerName} is registered twice`);
    this.name = 'DuplicateHandlerError';
  }
}

/**
 * Boot-time registry (F36). A handler without a declared policy cannot be
 * registered, so the module fails to boot rather than serving an unguarded
 * command — a scoring command especially, where the unguarded case is someone
 * re-scoring an exam they have no business touching.
 */
export class HandlerRegistry {
  readonly #handlers = new Map<string, Handler<never, unknown>>();

  static of(handlers: readonly Handler<never, unknown>[]): HandlerRegistry {
    const registry = new HandlerRegistry();
    for (const handler of handlers) registry.register(handler);
    return registry;
  }

  register<TInput, TOutput>(handler: Handler<TInput, TOutput>): void {
    const declared = handler.policy as AuthorizationPolicy | undefined;
    if (declared === undefined || declared.allowedRoles.length === 0) {
      throw new MissingAuthorizationPolicyError(handler.name);
    }
    if (this.#handlers.has(handler.name)) {
      throw new DuplicateHandlerError(handler.name);
    }
    this.#handlers.set(handler.name, handler as unknown as Handler<never, unknown>);
  }

  get names(): readonly string[] {
    return [...this.#handlers.keys()];
  }

  get<TInput, TOutput>(name: string): Handler<TInput, TOutput> | undefined {
    return this.#handlers.get(name) as Handler<TInput, TOutput> | undefined;
  }
}
