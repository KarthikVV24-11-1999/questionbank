import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkProxy, checkProxyFiles, locationsOf, PROXY_FILES } from './proxy-rules.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const real = (file: string): string => readFileSync(resolve(ROOT, file), 'utf8');
const PLAIN = `server { listen 8080; location /v1/ { proxy_pass http://api:3000; proxy_set_header Host $host; } location / { try_files $uri /index.html; } }`;

describe('the real proxies', () => {
  it('pass /v1/ and nothing else, so /metrics, /healthz and /readyz are not reachable through them', () => {
    expect(checkProxyFiles(ROOT)).toEqual([]);
  });

  it('are the two that are in front of the API, and each does proxy /v1/', () => {
    expect([...PROXY_FILES]).toEqual(['apps/learn/nginx.conf', 'apps/studio/nginx.conf']);
    for (const file of PROXY_FILES) expect(locationsOf(real(file)).filter((l) => /proxy_pass/u.test(l.body)).map((l) => l.path), file).toEqual(['/v1/']);
  });
});

describe('planted: a proxy that passes more than /v1/ is refused', () => {
  const rules = (config: string): string[] => checkProxy(config).map((v) => v.rule);

  it('the plain configuration is clean', () => {
    expect(checkProxy(PLAIN)).toEqual([]);
  });

  it('a location for the metrics page that proxies', () => {
    expect(checkProxy(PLAIN.replace('location / {', 'location /metrics { proxy_pass http://api:3000; } location / {'))).toEqual([{ rule: 'PROXY_PASS_OUTSIDE_V1', detail: 'nginx.conf: location /metrics' }]);
  });

  it('the health routes, an exact location, and the root', () => {
    expect(rules(PLAIN.replace('location / {', 'location /healthz { proxy_pass http://api:3000; } location / {'))).toEqual(['PROXY_PASS_OUTSIDE_V1']);
    expect(rules(PLAIN.replace('location / {', 'location = /metrics { proxy_pass http://api:3000; } location / {'))).toEqual(['PROXY_NOT_PLAIN_PREFIX']);
    expect(rules(PLAIN.replace('try_files $uri /index.html;', 'proxy_pass http://api:3000;'))).toEqual(['PROXY_PASS_OUTSIDE_V1']);
  });

  it('a regular-expression location that happens to include /v1/', () => {
    expect(rules(PLAIN.replace('location /v1/ {', 'location ~ ^/(v1|metrics)/ {'))).toEqual(['PROXY_NOT_PLAIN_PREFIX']);
    expect(rules(PLAIN.replace('location /v1/ {', 'location ~* ^/v1 {'))).toEqual(['PROXY_NOT_PLAIN_PREFIX']);
    expect(rules(PLAIN.replace('location /v1/ {', 'location ^~ /v1/ {'))).toEqual(['PROXY_NOT_PLAIN_PREFIX']);
  });

  it('a /v1/ location that rewrites or returns, which can send a request elsewhere', () => {
    expect(rules(PLAIN.replace('proxy_set_header Host $host;', 'rewrite ^/v1/x$ /metrics break;'))).toEqual(['PROXY_LOCATION_REWRITES']);
    expect(rules(PLAIN.replace('proxy_set_header Host $host;', 'return 307 /metrics;'))).toEqual(['PROXY_LOCATION_REWRITES']);
  });

  it('a proxy_pass in the server block, outside any location, which would apply to every request', () => {
    expect(checkProxy(PLAIN.replace('listen 8080;', 'listen 8080; proxy_pass http://api:3000;'))).toEqual([{ rule: 'PROXY_PASS_OUTSIDE_V1', detail: 'nginx.conf: proxy_pass outside a location' }]);
  });

  it('is not fooled by a comment, or by a nested block in a location', () => {
    expect(checkProxy(`${PLAIN}\n# location /metrics { proxy_pass http://api:3000; }`)).toEqual([]);
    expect(rules('server { location /v1/ { if ($x) { return 403; } proxy_pass http://api:3000; } }')).toEqual(['PROXY_LOCATION_REWRITES']);
  });

  it('names the file it was given', () => {
    expect(checkProxy(PLAIN.replace('location / {', 'location /metrics { proxy_pass http://x; } location / {'), 'apps/studio/nginx.conf')[0]?.detail).toBe('apps/studio/nginx.conf: location /metrics');
  });
});
