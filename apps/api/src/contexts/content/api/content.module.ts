import { Module, type DynamicModule } from '@nestjs/common';
import { HandlerRegistry, type Handler } from '../application/handler-registry.js';
import { AuthoringController } from './authoring.controller.js';
import { ContentController } from './content.controller.js';
import { CONTENT_PRINCIPAL_RESOLVER, CONTENT_REGISTRY, type PrincipalResolver } from './http-runner.js';

export interface ContentModuleOptions {
  readonly handlers: readonly Handler<never, unknown>[];
  readonly principals: PrincipalResolver;
}

/**
 * Wires the content HTTP surface. Building the registry is what enforces F36:
 * a handler without a policy throws here, so the module — and therefore the
 * application — fails to boot rather than serving an unguarded authoring
 * command, which is a command that edits an answer key.
 */
@Module({})
export class ContentModule {
  static register(options: ContentModuleOptions): DynamicModule {
    const registry = HandlerRegistry.of(options.handlers);

    return {
      module: ContentModule,
      controllers: [AuthoringController, ContentController],
      providers: [
        { provide: CONTENT_REGISTRY, useValue: registry },
        { provide: CONTENT_PRINCIPAL_RESOLVER, useValue: options.principals },
      ],
    };
  }
}
