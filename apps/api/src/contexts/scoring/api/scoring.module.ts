import { Module, type DynamicModule } from '@nestjs/common';
import { HandlerRegistry, type Handler } from '../application/handler-registry.js';
import {
  SCORING_PRINCIPAL_RESOLVER,
  SCORING_REGISTRY,
  ScoringController,
  type PrincipalResolver,
} from './scoring.controller.js';

export interface ScoringModuleOptions {
  readonly handlers: readonly Handler<never, unknown>[];
  readonly principals: PrincipalResolver;
}

/**
 * Wires the scoring HTTP surface. Building the registry is what enforces F36:
 * a handler without a policy throws here, so the module — and therefore the
 * application — fails to boot rather than serving an unguarded re-score.
 */
@Module({})
export class ScoringModule {
  static register(options: ScoringModuleOptions): DynamicModule {
    const registry = HandlerRegistry.of(options.handlers);

    return {
      module: ScoringModule,
      controllers: [ScoringController],
      providers: [
        { provide: SCORING_REGISTRY, useValue: registry },
        { provide: SCORING_PRINCIPAL_RESOLVER, useValue: options.principals },
      ],
    };
  }
}
