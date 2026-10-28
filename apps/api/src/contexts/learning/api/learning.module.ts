import { Module, type DynamicModule } from '@nestjs/common';
import type { LearningForLearner } from '../public/composition.js';
import { LEARNING_HANDLERS, LEARNING_PRINCIPAL_RESOLVER, LearningController, type PrincipalResolver } from './learning.controller.js';

export interface LearningModuleOptions {
  readonly handlers: LearningForLearner;
  readonly principals: PrincipalResolver;
}

/** Wires the learner's surface into the application. The handlers arrive already built, from the same composition the root reads. */
@Module({})
export class LearningModule {
  static register(options: LearningModuleOptions): DynamicModule {
    return {
      module: LearningModule,
      controllers: [LearningController],
      providers: [
        { provide: LEARNING_HANDLERS, useValue: options.handlers },
        { provide: LEARNING_PRINCIPAL_RESOLVER, useValue: options.principals },
      ],
    };
  }
}
