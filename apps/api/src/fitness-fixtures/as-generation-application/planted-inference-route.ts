// Planted violation for generation-rules.spec.ts (M5-38, F33): a controller that
// reaches a model on a request — importing the provider adapter and routing the
// handler that calls it. Never imported by production code.
import { RecordedProvider } from '../../contexts/generation/infrastructure/provider/recorded-provider.js';

export class PlantedInferenceController {
  constructor(private readonly registry: { get(name: string): unknown }) {}

  propose(): unknown {
    return [RecordedProvider, this.registry.get('ProposeCandidate'), this.registry.get('RunPrecheckBattery')];
  }
}
