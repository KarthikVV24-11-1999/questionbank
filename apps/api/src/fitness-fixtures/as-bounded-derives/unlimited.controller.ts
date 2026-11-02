declare const response: unknown;
declare const headers: unknown;
declare const ip: string;
declare const route: {
  handlers: { login: unknown; logout: unknown; surprise: unknown };
  run(...args: unknown[]): Promise<void>;
};

/** Planted: a route that derives, left unlimited with null, one with the argument left out, and one whose handler is not in the composition at all. */
export class Routes {
  readonly handlers = route.handlers;
  run = route.run;
  async login(): Promise<void> {
    await this.run(response, headers, this.handlers.login, {}, 200, 'anonymous', null, ip);
  }
  async loginAgain(): Promise<void> {
    await this.run(response, headers, this.handlers.login, {}, 200, 'anonymous');
  }
  async surprise(): Promise<void> {
    await this.run(response, headers, this.handlers.surprise, {}, 200, 'anonymous', null, ip);
  }
}
