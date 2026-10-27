import request from 'supertest';
import type { INestApplication } from '@nestjs/common';

/**
 * Planted for `loopback-rules.spec.ts`: a spec-shaped file that sends requests to an application it started with `init()`, which leaves supertest to listen
 * on the wildcard address. Not a spec; never run.
 */
export async function sendsOnTheWildcard(app: INestApplication): Promise<number> {
  await app.init();
  return (await request(app.getHttpServer()).get('/ping')).status;
}
