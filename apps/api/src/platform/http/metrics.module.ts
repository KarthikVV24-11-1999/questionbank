import { Module, type DynamicModule } from '@nestjs/common';
import type { MetricsRegistry } from '../observability/metrics.js';
import { METRICS_REGISTRY, MetricsController } from './metrics.controller.js';

@Module({})
export class MetricsModule {
  static register(registry: MetricsRegistry): DynamicModule {
    return { module: MetricsModule, controllers: [MetricsController], providers: [{ provide: METRICS_REGISTRY, useValue: registry }] };
  }
}
