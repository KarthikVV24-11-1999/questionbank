import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnalyticsEnvelope } from '@questionbank/contracts/analytics';

/**
 * Where an admitted event goes. EVENT-TAXONOMY §1 rule 2 says date-partitioned Parquet in object storage and never the OLTP database; there is no object storage
 * at M7, so the edge writes to this port and the real sink is M8's (DEC-M7-36, D90). Conformance is measured at the edge, before the sink.
 */
export interface AnalyticsSink {
  write(event: AnalyticsEnvelope): Promise<void>;
}

/** Keeps what it is given, for a test and for a process with nowhere to write. */
export class MemorySink implements AnalyticsSink {
  readonly events: AnalyticsEnvelope[] = [];
  async write(event: AnalyticsEnvelope): Promise<void> {
    this.events.push(event);
  }
}

/** One line of JSON per event, in a directory per day of ingestion (`dt=YYYY-MM-DD/events.ndjson`), the layout the Parquet sink will partition by. */
export class LocalDirectorySink implements AnalyticsSink {
  constructor(private readonly root: string) {}

  async write(event: AnalyticsEnvelope): Promise<void> {
    const directory = join(this.root, `dt=${event.received_at.slice(0, 10)}`);
    await mkdir(directory, { recursive: true });
    await appendFile(join(directory, 'events.ndjson'), `${JSON.stringify(event)}\n`);
  }
}
