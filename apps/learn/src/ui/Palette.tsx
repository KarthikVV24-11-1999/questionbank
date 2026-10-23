import type { JSX } from 'react';
import type { PackageSlot } from '../package/types.js';
import { TOKENS } from '../tokens.js';

export interface PaletteEntry {
  readonly slot: PackageSlot;
  readonly answered: boolean;
  readonly flagged: boolean;
  readonly current: boolean;
}

export function Palette({ entries, onGo }: { readonly entries: readonly PaletteEntry[]; readonly onGo: (slotId: string) => void }): JSX.Element {
  return (
    <nav aria-label="Questions" style={{ padding: TOKENS.spaceSmall }}>
      {entries.map(({ slot, answered, flagged, current }) => (
        <button
          key={slot.slotId}
          type="button"
          onClick={() => onGo(slot.slotId)}
          aria-current={current ? 'step' : undefined}
          aria-label={`Question ${slot.ordinal}${answered ? ', answered' : ', not answered'}${flagged ? ', flagged for review' : ''}`}
          style={{ borderColor: current ? TOKENS.accent : TOKENS.borderSubtle }}
        >
          {slot.ordinal}
          {flagged ? ' ⚑' : ''}
        </button>
      ))}
    </nav>
  );
}
