import { Module, type DynamicModule } from '@nestjs/common';
import type { PrincipalResolver } from '../auth/principal-resolver.js';
import { ANALYTICS_EDGE, ANALYTICS_PRINCIPALS, AnalyticsController } from './analytics.controller.js';
import type { AnalyticsEdge } from './edge.js';

@Module({})
export class AnalyticsModule {
  static register(options: { readonly edge: AnalyticsEdge; readonly principals: PrincipalResolver }): DynamicModule {
    return {
      module: AnalyticsModule,
      controllers: [AnalyticsController],
      providers: [
        { provide: ANALYTICS_EDGE, useValue: options.edge },
        { provide: ANALYTICS_PRINCIPALS, useValue: options.principals },
      ],
    };
  }
}
