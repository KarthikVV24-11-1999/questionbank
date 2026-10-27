import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { serveOnLoopback } from '../../testing/loopback.js';

/** Permitted: the same request, to an application bound to loopback first. Not a spec; never run. */
export async function sendsOnLoopback(app: INestApplication): Promise<number> {
  await serveOnLoopback(app);
  return (await request(app.getHttpServer()).get('/ping')).status;
}
