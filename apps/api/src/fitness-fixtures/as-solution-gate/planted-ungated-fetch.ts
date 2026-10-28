/** A caller that asks for a solution without the gate: it names the source and hands it whatever it has. */
export async function ungated(source: { solutionFor(slot: unknown, depth: string, context: unknown): Promise<unknown> }, slot: unknown, context: unknown) {
  return source.solutionFor(slot, 'basic', context);
}
