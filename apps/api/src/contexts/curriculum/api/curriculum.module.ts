import { Module, type DynamicModule } from '@nestjs/common';
import { HandlerRegistry, type Handler } from '../application/handler-registry.js';
import {
  CURRICULUM_REGISTRY,
  CurriculumController,
  PRINCIPAL_RESOLVER,
  type PrincipalResolver,
} from './curriculum.controller.js';

export interface CurriculumModuleOptions {
  readonly handlers: readonly Handler<never, unknown>[];
  readonly principals: PrincipalResolver;
}

/**
 * Wires the curriculum HTTP surface. Building the registry is what enforces
 * F36: a handler without a policy throws here, so the module — and therefore
 * the application — fails to boot.
 */
@Module({})
export class CurriculumModule {
  static register(options: CurriculumModuleOptions): DynamicModule {
    const registry = HandlerRegistry.of(options.handlers);

    return {
      module: CurriculumModule,
      controllers: [CurriculumController],
      providers: [
        { provide: CURRICULUM_REGISTRY, useValue: registry },
        { provide: PRINCIPAL_RESOLVER, useValue: options.principals },
      ],
    };
  }
}
