import { Module, type DynamicModule } from '@nestjs/common';
import type { HandlerRegistry } from '../application/handler-registry.js';
import {
  GENERATION_PRINCIPAL_RESOLVER,
  GENERATION_REGISTRY,
  GenerationController,
  type PrincipalResolver,
} from './generation.controller.js';

export interface GenerationModuleOptions {
  readonly registry: HandlerRegistry;
  readonly principals: PrincipalResolver;
}

/**
 * Wires generation into the application. The registry arrives already built:
 * building it is what enforces F36 — a handler without a policy throws in
 * `composeGenerationHandlers` — so a context whose handlers are unguarded does not
 * reach this module, and the application does not boot.
 */
@Module({})
export class GenerationModule {
  static register(options: GenerationModuleOptions): DynamicModule {
    return {
      module: GenerationModule,
      controllers: [GenerationController],
      providers: [
        { provide: GENERATION_REGISTRY, useValue: options.registry },
        { provide: GENERATION_PRINCIPAL_RESOLVER, useValue: options.principals },
      ],
    };
  }
}
