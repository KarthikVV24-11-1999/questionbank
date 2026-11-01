import { Module, type DynamicModule } from '@nestjs/common';
import type { IdentityHandlers } from '../public/composition.js';
import { IDENTITY_HANDLERS, IDENTITY_PRINCIPAL_RESOLVER, IdentityController, type PrincipalResolver } from './identity.controller.js';

export interface IdentityModuleOptions {
  readonly handlers: IdentityHandlers;
  readonly principals: PrincipalResolver;
}

@Module({})
export class IdentityModule {
  static register(options: IdentityModuleOptions): DynamicModule {
    return {
      module: IdentityModule,
      controllers: [IdentityController],
      providers: [
        { provide: IDENTITY_HANDLERS, useValue: options.handlers },
        { provide: IDENTITY_PRINCIPAL_RESOLVER, useValue: options.principals },
      ],
    };
  }
}
