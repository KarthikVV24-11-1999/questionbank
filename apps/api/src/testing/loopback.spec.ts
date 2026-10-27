import { createServer, type Server } from 'node:http';
import { createServer as createSocketServer, type AddressInfo } from 'node:net';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { serveOnLoopback } from './loopback.js';

@Controller()
class PingController {
  @Get('/ping')
  ping(): { pong: true } {
    return { pong: true };
  }
}

let app: INestApplication | undefined;
let stray: Server | undefined;

afterEach(async () => {
  await app?.close();
  await new Promise<void>((resolve) => (stray === undefined ? resolve() : stray.close(() => resolve())));
  app = undefined;
  stray = undefined;
});

async function booted(): Promise<INestApplication> {
  const module = await Test.createTestingModule({ controllers: [PingController] }).compile();
  app = module.createNestApplication();
  await serveOnLoopback(app);
  return app;
}

describe('a server for supertest takes a loopback port nothing else holds (D73)', () => {
  it('is listening on 127.0.0.1, which is where supertest connects, and nowhere else', async () => {
    const running = await booted();
    const address = running.getHttpServer().address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    expect(address.family).toBe('IPv4');
    expect(address.port).toBeGreaterThan(0);
  });

  it('answers requests as the application, and does not let supertest start it again', async () => {
    const running = await booted();
    const before = (running.getHttpServer().address() as AddressInfo).port;
    for (let i = 0; i < 25; i += 1) {
      const response = await request(running.getHttpServer()).get('/ping');
      expect([response.status, response.body]).toEqual([200, { pong: true }]);
    }
    // one listener for all of them: the port is held for as long as the application runs, so nothing else can take it between two requests
    expect((running.getHttpServer().address() as AddressInfo).port).toBe(before);
  });

  it('cannot share its port with another loopback listener: the collision that sent a request to someone else\'s server cannot happen', async () => {
    const running = await booted();
    const port = (running.getHttpServer().address() as AddressInfo).port;
    const intruder = createSocketServer();
    await expect(new Promise((resolve, reject) => {
      intruder.once('error', reject);
      intruder.listen(port, '127.0.0.1', () => resolve(undefined));
    })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    intruder.close();
  });

  it('is the difference from a stray loopback listener, which answers an unknown path with a bare 404 and not with the application', async () => {
    // what a headless browser's debugging port left running by an earlier run does: nothing in it knows this application's routes
    stray = createServer((_req, res) => {
      res.writeHead(404, { 'Content-Length': 0, 'Content-Type': 'text/html' });
      res.end();
    });
    await new Promise<void>((resolve) => stray!.listen(0, '127.0.0.1', resolve));
    const strayPort = (stray.address() as AddressInfo).port;
    const strayAnswer = await request(`http://127.0.0.1:${strayPort}`).post('/v1/assessment/attempts').send({});
    expect([strayAnswer.status, strayAnswer.text, strayAnswer.headers['x-correlation-id']]).toEqual([404, '', undefined]);

    const running = await booted();
    const port = (running.getHttpServer().address() as AddressInfo).port;
    expect(port).not.toBe(strayPort);
    const own = await request(running.getHttpServer()).get('/ping');
    expect(own.status).toBe(200);
  });
});
