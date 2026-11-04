import { readFileSync } from 'node:fs';

/**
 * What the proxies in front of the API may pass (M8-53). The learner app's nginx and Studio's are reachable from the network, and the API's `/metrics`, `/healthz` and `/readyz` are
 * unauthenticated and are published on the loopback address on purpose (D123). A proxy that passed them would put the metrics page, with its route list and its backlog, in front of anyone.
 *
 * The rule is over the configuration text, and it is a closed rule and not a list of names to avoid: **a `proxy_pass` may appear only inside `location /v1/`, a plain prefix location**. A
 * regular-expression location, an exact one, the root, or a location named for an operational route that proxies is a violation, so a new route is refused by default and not allowed by
 * default. A `rewrite` or a `return` in a proxying location is refused too, because either can send a request somewhere the location's name does not say.
 *
 * What it does not do: say anything of a proxy in front of these two (the owner's TLS proxy, docs/DEPLOYMENT.md), which this repository does not hold. DEPLOYMENT.md says what it must pass.
 */
export interface ProxyViolation {
  readonly rule: 'PROXY_PASS_OUTSIDE_V1' | 'PROXY_LOCATION_REWRITES' | 'PROXY_NOT_PLAIN_PREFIX';
  readonly detail: string;
}

interface Location {
  readonly modifier: string;
  readonly path: string;
  readonly body: string;
}

/** The `location` blocks of a configuration, each with its modifier (`~`, `=`, ...), its path and its body. Blocks are nested by braces. */
export function locationsOf(config: string): Location[] {
  const text = config.replace(/#[^\n]*/gu, '');
  const found: Location[] = [];
  const opening = /\blocation\s+(?:(~\*|~|=|\^~)\s+)?(\S+)\s*\{/gu;
  for (let match = opening.exec(text); match !== null; match = opening.exec(text)) {
    let depth = 1;
    let at = opening.lastIndex;
    while (depth > 0 && at < text.length) {
      if (text[at] === '{') depth += 1;
      else if (text[at] === '}') depth -= 1;
      at += 1;
    }
    found.push({ modifier: match[1] ?? '', path: match[2] as string, body: text.slice(opening.lastIndex, at - 1) });
  }
  return found;
}

export function checkProxy(config: string, file = 'nginx.conf'): ProxyViolation[] {
  const violations: ProxyViolation[] = [];
  for (const location of locationsOf(config)) {
    if (!/\bproxy_pass\b/u.test(location.body)) continue;
    const name = `${file}: location ${location.modifier === '' ? '' : `${location.modifier} `}${location.path}`;
    if (location.modifier !== '') violations.push({ rule: 'PROXY_NOT_PLAIN_PREFIX', detail: name });
    else if (location.path !== '/v1/') violations.push({ rule: 'PROXY_PASS_OUTSIDE_V1', detail: name });
    if (/\b(?:rewrite|return)\b/u.test(location.body)) violations.push({ rule: 'PROXY_LOCATION_REWRITES', detail: name });
  }
  // a proxy_pass outside any location (in the server block) would apply to every request
  const outside = locationsOf(config).reduce((text, location) => text.replace(location.body, ''), config.replace(/#[^\n]*/gu, ''));
  if (/\bproxy_pass\b/u.test(outside)) violations.push({ rule: 'PROXY_PASS_OUTSIDE_V1', detail: `${file}: proxy_pass outside a location` });
  return violations;
}

export const PROXY_FILES = ['apps/learn/nginx.conf', 'apps/studio/nginx.conf'] as const;

export function checkProxyFiles(repoRoot: string, files: readonly string[] = PROXY_FILES): ProxyViolation[] {
  return files.flatMap((file) => checkProxy(readFileSync(`${repoRoot}/${file}`, 'utf8'), file));
}
