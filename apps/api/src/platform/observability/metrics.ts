/**
 * The metrics the API exposes (M8-53), in the plain text exposition format that Prometheus and anything compatible with it reads. Counters, histograms and gauges, and nothing else: no
 * exporter, no collector, no SDK (D31). A host scrapes `GET /metrics`, which the API publishes on the loopback address and the learner app's proxy does not pass through.
 *
 * **What a label may be.** A name from a closed set the code chose (a route template, a status class, a tier), never a value a request supplied: a user id, an address or a path with an
 * identifier in it would make a series per person and put a person in a metric. `Counter.inc` and `Histogram.observe` take the labels as given, so the callers in `api-metrics.ts` are
 * where that is kept true, and `api-metrics.spec.ts` asserts it for the routes.
 *
 * **Gauges are read when asked.** A gauge is a function, called at each scrape, so a depth is the depth now and not the depth at the last write. A gauge whose read throws is reported as
 * `qb_collector_failed{collector="<name>"} 1` and the rest of the page is still served, because a scrape that fails whenever the database does tells an operator nothing about the database.
 */
export type Labels = Readonly<Record<string, string>>;
export interface Sample {
  readonly labels?: Labels;
  readonly value: number;
}

const NAME = /^[a-z_][a-z0-9_]*$/u;
export const LATENCY_BUCKETS_SECONDS: readonly number[] = Object.freeze([0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 1.5, 2, 3, 5, 10]);

const escapeValue = (value: string): string => value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/\n/gu, '\\n');
const key = (labels: Labels): string => Object.keys(labels).sort().map((name) => `${name}=${labels[name]}`).join('\u0000');
function rendered(labels: Labels | undefined): string {
  const names = Object.keys(labels ?? {}).sort();
  if (names.length === 0) return '';
  return `{${names.map((name) => `${name}="${escapeValue((labels as Labels)[name] as string)}"`).join(',')}}`;
}
const number = (value: number): string => (Number.isFinite(value) ? String(value) : value > 0 ? '+Inf' : value < 0 ? '-Inf' : 'NaN');

export class Counter {
  readonly #series = new Map<string, { labels: Labels; value: number }>();
  constructor(readonly name: string, readonly help: string) {}

  inc(labels: Labels = {}, by = 1): void {
    if (!(by >= 0)) throw new RangeError(`counter ${this.name} only goes up`);
    const id = key(labels);
    const found = this.#series.get(id);
    if (found === undefined) this.#series.set(id, { labels, value: by });
    else found.value += by;
  }

  lines(): string[] {
    return [...this.#series.values()].map((series) => `${this.name}${rendered(series.labels)} ${number(series.value)}`);
  }
}

export class Histogram {
  readonly #series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  constructor(readonly name: string, readonly help: string, readonly buckets: readonly number[] = LATENCY_BUCKETS_SECONDS) {}

  observe(labels: Labels, value: number): void {
    const id = key(labels);
    let series = this.#series.get(id);
    if (series === undefined) {
      series = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.#series.set(id, series);
    }
    this.buckets.forEach((bound, index) => {
      if (value <= bound) (series as { counts: number[] }).counts[index]! += 1;
    });
    series.sum += value;
    series.count += 1;
  }

  lines(): string[] {
    const out: string[] = [];
    for (const series of this.#series.values()) {
      this.buckets.forEach((bound, index) => out.push(`${this.name}_bucket${rendered({ ...series.labels, le: String(bound) })} ${series.counts[index]}`));
      out.push(`${this.name}_bucket${rendered({ ...series.labels, le: '+Inf' })} ${series.count}`);
      out.push(`${this.name}_sum${rendered(series.labels)} ${number(series.sum)}`);
      out.push(`${this.name}_count${rendered(series.labels)} ${series.count}`);
    }
    return out;
  }
}

interface GaugeEntry {
  readonly name: string;
  readonly help: string;
  readonly read: () => Promise<readonly Sample[]> | readonly Sample[];
}

export class MetricsRegistry {
  readonly #names = new Set<string>();
  readonly #counters: Counter[] = [];
  readonly #histograms: Histogram[] = [];
  readonly #gauges: GaugeEntry[] = [];

  #claim(name: string): void {
    if (!NAME.test(name)) throw new RangeError(`${name} is not a metric name`);
    if (this.#names.has(name)) throw new RangeError(`two metrics are named ${name}`);
    this.#names.add(name);
  }

  counter(name: string, help: string): Counter {
    this.#claim(name);
    const counter = new Counter(name, help);
    this.#counters.push(counter);
    return counter;
  }

  histogram(name: string, help: string, buckets?: readonly number[]): Histogram {
    this.#claim(name);
    const histogram = new Histogram(name, help, buckets);
    this.#histograms.push(histogram);
    return histogram;
  }

  gauge(name: string, help: string, read: GaugeEntry['read']): void {
    this.#claim(name);
    this.#gauges.push({ name, help, read });
  }

  /** The page: every counter, histogram and gauge, each with its help and type, and a line for each gauge that could not be read. */
  async render(): Promise<string> {
    const out: string[] = [];
    for (const counter of this.#counters) out.push(`# HELP ${counter.name} ${counter.help}`, `# TYPE ${counter.name} counter`, ...counter.lines());
    for (const histogram of this.#histograms) out.push(`# HELP ${histogram.name} ${histogram.help}`, `# TYPE ${histogram.name} histogram`, ...histogram.lines());
    const failed: string[] = [];
    for (const gauge of this.#gauges) {
      let samples: readonly Sample[];
      try {
        samples = await gauge.read();
      } catch {
        failed.push(gauge.name);
        continue;
      }
      out.push(`# HELP ${gauge.name} ${gauge.help}`, `# TYPE ${gauge.name} gauge`, ...samples.map((sample) => `${gauge.name}${rendered(sample.labels)} ${number(sample.value)}`));
    }
    out.push('# HELP qb_collector_failed A gauge that could not be read at this scrape.', '# TYPE qb_collector_failed gauge', ...failed.map((name) => `qb_collector_failed{collector="${name}"} 1`));
    return `${out.join('\n')}\n`;
  }
}
