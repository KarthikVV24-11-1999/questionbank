import { Controller, Get } from '@nestjs/common';

/** Planted: a controller with a route that asks nobody who is calling. */
@Controller()
export class OpenController {
  @Get('/v1/open')
  everything(): string {
    return 'everyone';
  }
}
