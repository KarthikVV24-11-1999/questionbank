import { Controller, Get, Inject } from '@nestjs/common';

export const THING_PRINCIPAL_RESOLVER = Symbol('THING_PRINCIPAL_RESOLVER');

/** Not a violation: the controller takes the port. */
@Controller()
export class ClosedController {
  constructor(@Inject(THING_PRINCIPAL_RESOLVER) private readonly principals: { resolve(headers: object): object | null }) {}

  @Get('/v1/closed')
  some(): string {
    return this.principals === undefined ? '' : 'someone';
  }
}
