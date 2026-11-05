import { Module, type DynamicModule } from '@nestjs/common';
import type { LearningForLearner } from '../public/composition.js';
import type { ProfileAdmission } from './admission.js';
import { LEARNING_ADMISSION, LEARNING_HANDLERS, LEARNING_READS_ADMISSION, LEARNING_PRINCIPAL_RESOLVER, LearningController, type PrincipalResolver } from './learning.controller.js';

export interface LearningModuleOptions {
  readonly handlers: LearningForLearner;
  readonly principals: PrincipalResolver;
  readonly admission: ProfileAdmission;
  /** For every route that is not the profile's (M8-58): the map, a topic's answers, the review plan, errors and bookmarks. */
  readonly reads: ProfileAdmission;
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
        { provide: LEARNING_ADMISSION, useValue: options.admission },
        { provide: LEARNING_READS_ADMISSION, useValue: options.reads },
      ],
    };
  }
}
