declare const response: unknown;
declare const headers: unknown;
declare const ip: string;
declare const route: {
  handlers: { login: unknown; logout: unknown };
  run(...args: unknown[]): Promise<void>;
};

/** Planted, and fine: the route that derives names a limit, and the one that does not says it needs none. */
export class Routes {
  readonly handlers = route.handlers;
  run = route.run;
  async login(): Promise<void> {
    await this.run(response, headers, this.handlers.login, {}, 200, 'anonymous', { route: 'login', action: 'login', subject: null }, ip);
  }
  async logout(): Promise<void> {
    await this.run(response, headers, this.handlers.logout, {}, 200, 'session', null, ip);
  }
}
