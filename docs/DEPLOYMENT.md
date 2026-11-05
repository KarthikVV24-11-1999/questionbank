# Deploying the stack to one host

What is claimed, before the steps. The build, the migration, the seed and the start are the ones the `compose` job runs on a CI runner on every push (Tier 1, ADR-0013): `infra/compose/boot.mjs`. A learner's path through the app in a real browser is run against that stack in the same job. Everything on this page that happens **on a host that serves people** has not been run: the host, the domain, TLS, and mail through SES are the owner's to supply, and nothing in the repository can show they work (Tier 3: `docs/M8-ACCEPTANCE.md` records the SES line as `Fail — blocked`, D120). This page says which is which.

The process runs as `NODE_ENV=development`, on purpose and not by oversight: a `production` process does not start yet, because the only media store refuses it (D124). With the mail settings present, development mode sends through SES.

It deploys one host: Compose, one Postgres in a container with its data in a volume, the API, the learner app and Studio. It does not deploy `infra/terraform/`, which describes another target and is left as it stands (D118).

## What the owner must obtain

In the order to start them, longest wait first. Nothing here is a secret until it is made; none of it belongs in the repository.

1. **An AWS account with Amazon SES in one region, out of the sandbox.** A new SES account is in the *sandbox*: it sends only to addresses that have been verified one by one, so a stranger who registers receives nothing. Production access is a request to AWS, decided by AWS, and the wait is theirs; start it first, because nothing after it is on the critical path except this. While waiting, the sandbox is enough to run the smoke below to a verified address of your own.
2. **A domain, and control of its DNS.** For the address the learner app is reached at, and for the records SES asks for to verify the sender.
3. **A verified sender in SES**: a domain (three DKIM records, and optionally a mail-from domain) or, in the sandbox, a single address. This is `MAIL_SENDER`.
4. **An access key for SES**, from an IAM user allowed `ses:SendEmail` and nothing else. This is `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. The application takes a static key only; a role granted by the host is not read (D120).
5. **A host**: a machine with Docker and the Compose plugin, Node 22 with `corepack` (the seed commands run on the host, as they do on the runner), and `git`. The runner the job uses is `ubuntu-latest`; nothing smaller has been tried.
6. **A TLS certificate for the domain, and a proxy to terminate it.** The session is a `Secure` cookie, which a browser sends over HTTPS only (it makes an exception for `localhost`, which is why the CI browser run works). The proxy is the owner's choice; it must pass `Host` and `X-Forwarded-For` through and send everything to port 8080 of the host. The repository holds no proxy configuration, because none has been run.
7. **A firewall rule that leaves only 80 and 443 reachable from outside.** See the warning under the steps.

## The steps

Run these on the host, in this order. Every command is the one `boot.mjs` runs, with the compose file named in full.

**1. Get the code.**

```bash
git clone <the repository> questionbank && cd questionbank
```

**2. Make the environment file, outside the repository.** Three signing keys are made on the host and stay there; they must differ from each other, and the application refuses to start if two are equal. Everything else is set from the table below.

```bash
sudo install -d -m 700 /etc/questionbank
umask 077
{
  echo "AUTH_SIGNING_KEY=$(openssl rand -base64 32)"
  echo "AUDIT_ANCHOR_KEY=$(openssl rand -base64 32)"
  echo "FORM_PACKAGE_SIGNING_KEY=$(openssl rand -base64 32)"
  echo "QB_DB_PASSWORD=$(openssl rand -hex 18)"
} | sudo tee /etc/questionbank/stack.env >/dev/null
```

Then add, with an editor, the lines the host needs (`PUBLIC_URL`, `TRUST_PROXY_HOPS=2`, and the four mail settings). No step asks you to put any of it in a file under the repository, and the repository's own `.env.example` holds placeholders only.

**3. Build the images.**

```bash
docker compose --env-file /etc/questionbank/stack.env -f infra/compose/docker-compose.yml build
```

**4. Start the database, then apply the migrations.** The migrator records what it applied and takes a lock, so running it again applies nothing.

```bash
docker compose --env-file /etc/questionbank/stack.env -f infra/compose/docker-compose.yml up -d --wait postgres
docker compose --env-file /etc/questionbank/stack.env -f infra/compose/docker-compose.yml run --rm --no-deps api node migrate.js
```

**5. Start everything and wait for every health check.**

```bash
docker compose --env-file /etc/questionbank/stack.env -f infra/compose/docker-compose.yml up -d --wait
```

**6. Load the syllabus, the exam profiles and the demonstration questions.** These are the product's reference data; without the first two a learner has no exam to choose. Both are safe to run again. The demonstration questions are for trying the product, and a deployment with real content loads its own instead.

```bash
corepack enable && corepack pnpm install --frozen-lockfile
DATABASE_URL=postgres://postgres:$QB_DB_PASSWORD@127.0.0.1:5432/questionbank corepack pnpm --filter @questionbank/seed run seed
DATABASE_URL=postgres://postgres:$QB_DB_PASSWORD@127.0.0.1:5432/questionbank corepack pnpm --filter @questionbank/seed run seed:items
```

**7. Put the TLS proxy in front of port 8080** and point the domain at the host. `PUBLIC_URL` must be exactly the address people type, with `https://` and no path: the API refuses a browser request that names another origin (ADR-0065), so a `PUBLIC_URL` that is wrong or missing makes every sign-in-then-act request fail with a refusal and no other symptom.

**8. Try mail, once, to an address you can read.** This is the one step nothing in the repository can do for you (D120). It needs the whole environment, because it loads the application's own configuration.

```bash
set -a && . /etc/questionbank/stack.env && set +a
DATABASE_URL=postgres://postgres:$QB_DB_PASSWORD@127.0.0.1:5432/questionbank corepack pnpm --filter @questionbank/api mail-smoke you@your-verified-address.example
```

Exit 0 means SES took the message, which is not delivery; read the inbox. Exit 1 prints what SES said (an unverified sender, a recipient the sandbox does not allow, a bad key) without the key. Exit 2 means the mail settings are absent or incomplete.

**9. Walk the smoke path** below.

**10. Make the first administrator, if one is wanted.** Register and confirm the address in the app first, then:

```bash
set -a && . /etc/questionbank/stack.env && set +a
DATABASE_URL=postgres://postgres:$QB_DB_PASSWORD@127.0.0.1:5432/questionbank corepack pnpm --filter @questionbank/api bootstrap-admin you@your-verified-address.example
```

It refuses once an administrator exists. Studio has no sign-in yet (D121), so an administrator can assign roles through the API and cannot yet use Studio.

> **The Compose file publishes only the learner app on every interface** (8080, for the TLS proxy on this host). The database (5432), the API (3000), Studio (4173) and minio listen on `127.0.0.1`, and the database asks for `QB_DB_PASSWORD`; a rule in the `fitness` job fails if one of them is widened (D123). The firewall in item 7 is still the right second line, and the only one for 8080. **A database volume made before this change, under `trust`, keeps accepting anyone until it is removed** (`docker compose down -v`, which deletes its data) or its role is given a password; the password applies when a volume is first made. The file does not do it for you (D123).

## Every setting the API reads

Set in the environment file. *Secret* means: never written to a file in the repository, never printed in a log, and different on every deployment.

| Variable | Purpose | Secret | Default / note |
|---|---|---|---|
| `DATABASE_URL` | The database. Set by the Compose file for the container, from `QB_DB_PASSWORD`; the host commands above build it themselves. | **yes**, because it holds the password | required |
| `QB_DB_PASSWORD` | The database's password. Read by the Compose file; 36 hex characters from the command in step 2. | **yes** | none: Compose will not start without it |
| `NODE_ENV` | Fixed at `development` by the Compose file, and it has to be: a `production` process does not start (D124). Mail goes through SES when the four mail settings are present and to a file when they are not. | no | `development` |
| `AUTH_SIGNING_KEY` | The key the application's tokens are signed with. At least 32 bytes. | **yes** | none: the process will not start without it |
| `AUDIT_ANCHOR_KEY` | The audit trail's anchor. Must differ from the one above. | **yes** | none |
| `FORM_PACKAGE_SIGNING_KEY` | Signs the question packages a device verifies. 32 random bytes, base64. | **yes** | none: without it the package routes answer as unavailable |
| `PUBLIC_URL` | Where the learner app is reached: an origin, no path. The link in a message and the origin the API allows a browser's writes from. | no | Compose: `http://localhost:8080`; **set it** |
| `TRUST_PROXY_HOPS` | How many proxies in front of the API may be believed about a client's address. The learner app's nginx is one; a TLS proxy in front of it is two. Too low and every learner is one source for the rate limits. | no | Compose: `1`; `2` behind a TLS proxy |
| `MAIL_SES_REGION` | The SES region, for example `eu-west-1`. | no | all four mail settings or none: some refuses to start and names the missing ones |
| `MAIL_SENDER` | The verified sender address. | no | as above |
| `AWS_ACCESS_KEY_ID` | The SES key's id. | **yes** | as above |
| `AWS_SECRET_ACCESS_KEY` | The SES key's secret. | **yes** | as above |
| `QB_MAIL_DIR` | Where a process without the SES settings writes its messages. Unused when they are set. | no | a volume |
| `PORT`, `AUTH_ISSUER`, `AUTH_TOKEN_TTL_SECONDS`, `MEDIA_STORAGE_ROOT`, `LOG_LEVEL` | Set by the Compose file; change them only with a reason. | no | see `.env.example` |
| `MAX_SESSIONS_PER_USER`, `RATE_LIMIT_*` (including `RATE_LIMIT_LEARNING`, `RATE_LIMIT_EVENTS` and `RATE_LIMIT_ATTEMPTS`, the learner routes' allowances, DEC-M8-35: raise the source tier if a school behind one address is refused, and read `qb_refusals_total{code="RATE_LIMITED"}`), `PASSWORD_HASH_*`, `REVIEW_*`, `TIME_ON_ITEM_INTERVAL_CAP_MS`, `BACKGROUND_JOBS_ENABLED`, `GENERATION_PRECHECK_CONFIG` | Tuning. The defaults are the ones the tests run under. | no | see `.env.example`, which also says what each does |

A process with **none** of the mail settings writes each message to a file inside the container: nobody outside could read it, so nobody could confirm an address. With **some** it does not start and says which are missing. Check the mail settings before inviting anyone (step 8).

### Sign-in under load

`PASSWORD_HASH_CONCURRENCY` is how many passwords the process hashes at the same moment (1 to 16, default 2). Hashing is CPU work of 160 to 220 ms, so **set it to the host's cores** (leave one for the rest of the API on a small host) and the sign-in rate follows: about two sign-ins per core-second. A class of 200 signing in together on 2 cores clears in about 100 seconds of derive, on 8 cores about 25.

The queue behind it holds 256 and waits at most 15 seconds. Past either, the API answers 503 `Unavailable`, marked retryable. The learner app tries once more, after 1 to 3 s (2 s, jittered so a crowd does not return together), before it tells the person to try again in a minute, and says "this is taking a moment" after 3 s; the worst case is the 15 s hold, the pause and a second 15 s hold, about 33 s, so a refusal that reaches a person means the host is under-provisioned for the moment, not that anything is broken. Watch `qb_refusals_total` for the refusals and raise the setting, or the host, if they recur (D129).

## Metrics

`GET /metrics` on port 3000 answers in the plain text exposition format that Prometheus and anything compatible with it reads: requests and a latency histogram by route and status class, the outbox backlog and the age of its oldest message, the relay's lag (`qb_outbox_relay_seconds_since_drain`), the database pool by state, refusals by tier, and resident memory. It is **unauthenticated**, and what keeps it private is that the API listens on `127.0.0.1` and the learner app's proxy passes `/v1/` and nothing else (a rule in the `fitness` job fails if that changes). A scraper on the same host can read it at `http://127.0.0.1:3000/metrics`. **Your TLS proxy must not pass it either:** pass `/` to port 8080 and nothing to 3000. Nothing in the repository scrapes it, stores it or pages on it (D132).

## Watching it

What exists, and what does not. **Tier 2 (ADR-0013): everything in this section but the first paragraph is a file that has been parsed and never run.** The objectives, the alert rules and the probe are in the repository; nothing here scrapes, evaluates, stores or pages, because there is no monitoring system, no on-call rotation and no receiver for a page, and acceptance criterion 5 (pages per person per week) stays blocked on those (D132).

**Scrape `GET /metrics`** on port 3000 from the host (see Metrics above) with whatever you run; Prometheus, or an agent that reads the text format. `infra/observability/alerts.yaml` is a Prometheus rule file, rendered from `infra/observability/slo.json` by `node tools/observability/render-alerts.mjs` (change an objective, render again; `--check` fails if they differ). It holds, for each of six objectives, the three multiwindow burn-rate alerts (14.4x over an hour and five minutes, 6x over six hours and thirty, 1x over three days and six hours) and two for the absence of data. They have never been loaded by Prometheus, so check them with `promtool check rules infra/observability/alerts.yaml` before relying on them.

**Run the probe** from somewhere that is not the host, every five minutes. It signs in as one account you have made by registering through the app, reads what a learner's home reads, signs out, and exits non-zero naming the step. It needs three variables and a place to write, and holds no credential in the repository:

```bash
PROBE_URL=https://learn.example.org PROBE_EMAIL=probe@example.org PROBE_PASSWORD="$(cat /etc/questionbank/probe-password)" \
  PROBE_TEXTFILE=/var/lib/node_exporter/textfile/questionbank_probe.prom node tools/stack-journey/probe.mjs
```

On a schedule with cron: `*/5 * * * * <the line above>`, or a systemd timer. `PROBE_TEXTFILE` is in the text exposition format (`qb_probe_success`, `qb_probe_duration_seconds{step}`, `qb_probe_last_run_timestamp_seconds`), for a node exporter's textfile collector to pick up, and is what the `probe` objective and the `ProbeAbsent` alert read. The probe's account is a learner like any other: it counts in the learner totals, and its password should not be a person's.

### What a page means

**Tier 3 for the words, and they cannot be tested by behaviour: nobody has been paged, no alert has fired, and what follows is what the metrics and commands say, written before the first time, not learned from one.** What a test can say (`apps/api/src/fitness/observability-rules.spec.ts`) is that every objective in `infra/observability/slo.json` has an entry below with its three parts, and that every `qb_` metric named below is on the `/metrics` page. Whether the first three things are the right three is for the first real page to correct: write what it taught you into the entry.

Commands below run on the host, from the repository, with the Compose prefix of "The steps" (`docker compose --env-file /etc/questionbank/stack.env -f infra/compose/docker-compose.yml`, written `$COMPOSE`). `curl -s localhost:3000/metrics | grep <name>` reads a metric.

**A `ticket` is not a page**: it is the budget being spent at the rate that exhausts it in 28 days, and is read in working hours. A `page` is the first two burn windows of an objective (14.4x over an hour, 6x over six).

#### Runbook: availability

**What a page means.** More than 0.5% of requests are being answered with a server error, fast enough to spend the beta's 3.4 hours of error in days.
**Look at first.** (1) `qb_http_requests_total{status_class="5xx"}` by `route`: one route is a bug, every route is the process or the database. (2) `curl -s localhost:3000/readyz` (it asks the database) and `/healthz`. (3) `qb_db_pool_connections` by `state` (many `waiting` means the pool is exhausted) and `$COMPOSE logs --tail 200 api`, searching for a `correlationId` of a 5xx.
**A false alarm when** the host has just been restarted or deployed (the errors are the minute the process was down and the page clears by itself), or traffic is so low that three errors are a large share (`rate(qb_http_requests_total[1h])` is near zero).

#### Runbook: read-latency

**What a page means.** More than 5% of reads (any `GET`) took longer than 200 ms over the last hour or six.
**Look at first.** (1) `qb_http_request_duration_seconds_bucket` by `route` for `GET` routes: which one is slow. (2) `qb_db_pool_connections{state="waiting"}` and `qb_outbox_depth` (a relay catching up competes for the database). (3) `$COMPOSE exec -T postgres psql -U postgres -d questionbank -c "select pid, state, now() - query_start as age, left(query, 80) from pg_stat_activity where state <> 'idle' order by age desc limit 10"` for the query that is holding things.
**A false alarm when** a class has just signed in together (sign-ins are writes, but their CPU slows reads for the minute they last: `qb_refusals_total` and the hash queue, "Sign-in under load"), or traffic is near zero.

#### Runbook: write-latency

**What a page means.** More than 5% of writes (`POST`, `PATCH`, `PUT`, `DELETE`) took longer than 300 ms.
**Look at first.** (1) `qb_http_request_duration_seconds_bucket` by `route` for the writes: sign-in and registration are writes and hash a password in 160 to 220 ms by design. (2) `qb_refusals_total` by `code`: `RATE_LIMITED` is a limit being hit, and 503 `Unavailable` with the hash queue is the stampede of D129. (3) `qb_db_pool_connections{state="waiting"}`.
**A false alarm when** it is a class signing in together: the writes are slow for about as long as the sign-ins take to drain (about two a second per core, "Sign-in under load"), and the page clears. It is not one when the slow route is not sign-in or registration.

#### Runbook: concept-map-latency

**What a page means.** More than 5% of reads of a learner's concept map took longer than 500 ms: the screen a learner opens to see where they stand is slow.
**Look at first.** (1) `qb_http_request_duration_seconds_bucket{route="GET /v1/learning/concept-map"}`. (2) `qb_outbox_depth` and `qb_outbox_oldest_unrelayed_age_seconds`: the relay writes what the map reads, and a backlog is contention. (3) `qb_db_pool_connections` and the slow-query command under read-latency.
**A false alarm when** the process has just started (cold caches and a cold pool for the first requests) or very few maps have been read in the window.

#### Runbook: relay-freshness

**What a page means.** A message has waited more than a minute for the relay: a submitted run's score, or what a learner's home names next, is not being updated.
**Look at first.** (1) `qb_outbox_relay_seconds_since_drain`: growing means the relay has stopped (the process, a stuck drain), steady near 1 means it is running and behind. (2) `qb_outbox_oldest_unrelayed_age_seconds` and `qb_outbox_depth`: how old and how many. (3) `qb_outbox_dead`: dead letters are messages the relay gave up on, kept for a person, and need reading in `platform.outbox_message` (`dead_at is not null`) before anything is retried.
**A false alarm when** `qb_outbox_unconsumed` is what is growing and nothing else: those are messages of a type nothing consumes (D130), they are not counted in the age above and they are not a delay.

#### Runbook: probe

**What a page means.** The check made from outside, through the proxy, which signs in and reads what a learner's home reads, has failed on more than 1% of its runs: from where a learner is, the app does not work, or the probe cannot tell.
**Look at first.** (1) `qb_probe_success` and `qb_probe_duration_seconds` by `step`: which step failed. (2) Run it by hand, from somewhere that is not the host (the command under "Run the probe"): its exit code names the step. (3) `curl -s localhost:3000/readyz` on the host, then the learner app on 8080 (`curl -sI localhost:8080/`): if the host answers and the outside does not, it is the proxy, the certificate or the network, not the API.
**A false alarm when** the probe's own account has been signed out by another sign-in (an account holds one session: one probe, one place) or the probe host has lost the network; `ProbeAbsent` is the alert for a probe that is not running at all.

### Sev-1

A **Sev-1** for this product is one of three things, and nothing slower or smaller is: (1) **an answer is lost**: a learner was told their answers were saved or their run was submitted and they are not in the database, or a submitted run is never scored; (2) **someone sees what is not theirs**: another learner's standing, answers or account, or a question's key or solution before it is released; (3) **nobody can use it**: no learner can sign in or open a run for 30 minutes inside a scheduled mock's window, or for 2 hours at any other time. A slow screen, one learner's trouble, a `ticket` and a failed probe that the host answers are not Sev-1; the third kind is the one an alert on `availability` or `probe` is most likely to be, the first two are found by a person or by `qb_outbox_dead`. Acceptance criterion 3 counts these and only these.

**Where an incident is written.** In the repository, as `docs/incidents/<date>-<what>.md`, one file for each Sev-1 and for any page that taught something: what was seen, the times, what was done, what the entry above should now say. The directory does not exist yet because nothing is deployed to people; the first incident creates it, and adds the file to `docs/README.md`'s index.

## Health

| Route | Question | Answers |
|---|---|---|
| `GET /healthz` on port 3000 | Is the process up? Asks nothing of the database. | 200 `{"status":"ok"}` |
| `GET /readyz` on port 3000 | Can this instance serve a request? Asks the database. | 200, or 503 with the reason |
| `GET /` on port 8080 | Is the learner app served? | the page |

Compose uses the first and the last as the containers' health checks; a load balancer should use `/readyz`.

## The smoke path

After step 9, in a browser, with an address you can read:

1. Open the domain. You are shown a sign-in screen.
2. Create an account. You are told to check your mail.
3. The message arrives (from the sender you verified), with a link. If it does not: the sandbox, the sender, or the key. Run step 8 again and read what it says. "Send it again" on the same screen asks for another.
4. Open the link. The address is confirmed and you are offered the questions about your exam.
5. Choose an exam and the chapters you have studied; start the short diagnostic from the home screen, answer it and finish it.
6. Home names a topic to work on, and says it is "so far".
7. Sign out. You are shown the sign-in screen.

Steps 1, 2, 4, 5, 6 and 7 are what `tools/adversarial/src/stack-journey.ts` does in headless Chrome on the runner, against a stack in development mode. Step 3 is the one only a host can show.

## Backups and restoring

Two commands, against the stack's database in its volume. **Tier 1 for the mechanism, Tier 3 for your host:** `infra/compose/restore-drill.mjs` ran them in CI on every push, on the stack the `compose` job boots, backing up a database a learner had just used, dropping it, restoring it and counting every table again; nobody has run them on a host. The drill proves these scripts bring back what that stack's journeys made. It does not prove your disk, your cron, your copy or your retention.

```bash
infra/compose/backup.sh /var/backups/questionbank/$(date +%F).dump     # a custom-format pg_dump, read back before it is kept
infra/compose/restore.sh /var/backups/questionbank/2026-11-04.dump     # stops the API and the two proxies, REPLACES the database, says how to start again
```

`backup.sh` runs inside the database container, needs no password, and does not stop anything. `restore.sh` **replaces the database**: whatever it held since the backup is gone. After it, `docker compose --env-file /etc/questionbank/stack.env -f infra/compose/docker-compose.yml up -d --wait`, then the smoke path.

**What the owner has to decide and do, since the repository cannot:**

1. **Where a backup goes.** It is on the host's disk when `backup.sh` ends, which protects against a bad migration or a mistake and against nothing that takes the host. Copy it off the host (a bucket in another account or region, versioned) on every run. A backup that is only on the disk it protects is not one.
2. **How often.** At most the data you can afford to redo: a daily cron is a starting point, and a student's day of practice is what a daily backup can lose. The repository has no point-in-time recovery.
3. **How long it is kept.** Long enough to find a mistake made a while ago: two weeks of dailies is a starting point, with the retention set on the copy off the host.
4. **Who can read it.** A dump holds every learner's address, password hashes and answers. `chmod 600`, keep it out of the repository, and encrypt it before it leaves the host.
5. **Whether it restores.** Do not run `restore-drill.mjs` on a stack that holds real data: it drops the database. To try a backup without touching the live one, restore it into a second database and look:

```bash
docker compose --env-file /etc/questionbank/stack.env -f infra/compose/docker-compose.yml exec -T postgres createdb -U postgres qb_check
docker compose --env-file /etc/questionbank/stack.env -f infra/compose/docker-compose.yml exec -T postgres pg_restore -U postgres --dbname=qb_check --exit-on-error --no-owner < /var/backups/questionbank/2026-11-04.dump
docker compose --env-file /etc/questionbank/stack.env -f infra/compose/docker-compose.yml exec -T postgres psql -U postgres -d qb_check -c 'select count(*) from identity.app_user'
docker compose --env-file /etc/questionbank/stack.env -f infra/compose/docker-compose.yml exec -T postgres dropdb -U postgres qb_check
```

Do this once before anyone is invited, and on a schedule after.

**A volume that is gone** is restored the same way: start the database (`up -d --wait postgres`), run `restore.sh`, then start the rest. The dump carries the migrations table, so the migrator does not run again.

## What this page does not cover

Keeping the host patched; collecting logs and raising an alert (there is no production observability yet); bounces and complaints from SES (D120); running more than one host; Studio's sign-in (D121); and where the beta finally runs (D118).
