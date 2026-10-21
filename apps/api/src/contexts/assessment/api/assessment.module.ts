import { Module, type DynamicModule } from '@nestjs/common';
import type { HandlerRegistry } from '../application/handler-registry.js';
import { ASSESSMENT_PRINCIPAL_RESOLVER, ASSESSMENT_REGISTRY, AssessmentController, type PrincipalResolver } from './assessment.controller.js';

export interface AssessmentModuleOptions {
  readonly registry: HandlerRegistry;
  readonly principals: PrincipalResolver;
}

/**
 * Wires assessment into the application. The registry arrives already built:
 * building it is what enforces F36, so a context whose handlers are unguarded
 * does not reach this module and the application does not boot.
 */
@Module({})
export class AssessmentModule {
  static register(options: AssessmentModuleOptions): DynamicModule {
    return {
      module: AssessmentModule,
      controllers: [AssessmentController],
      providers: [
        { provide: ASSESSMENT_REGISTRY, useValue: options.registry },
        { provide: ASSESSMENT_PRINCIPAL_RESOLVER, useValue: options.principals },
      ],
    };
  }
}
