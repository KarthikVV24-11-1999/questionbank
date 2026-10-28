import type { PrincipalRef } from '@questionbank/domain-types';
import type { ContentForLearning } from '../../contexts/content/public/composition.js';
import type { ItemStanding, ItemStandingSource } from '../../contexts/learning/public/composition.js';
import { ROLES } from '../auth/roles.js';

/**
 * What content says of an item, looked up in pages of the size content states (D86), joined to what Learning asks of it (M7-38): the one place a bookmark's item is looked up in content's seam.
 * It lives in the root because it is the one place that may name both contexts; Learning holds the port and imports neither.
 *
 * The question is put as the system, because content's answer is the system's alone, and it carries identifiers and a word. A bookmark's owner is not
 * asked about and not sent: the learner's rows are read by Learning, and content never learns who is looking.
 */
const SYSTEM: PrincipalRef = { kind: 'system', id: '00000000-0000-4000-8000-0000000000f7', roleContext: [ROLES.system] };

export class ContentItemStandings implements ItemStandingSource {
  constructor(private readonly content: Pick<ContentForLearning, 'itemStanding' | 'batchBound'>) {}

  /**
   * The items asked about, in pages of the size content states (D86): content bounds a call and says by how much, so a learner with more bookmarks than one call
   * takes gets all of them, in order. A page content refuses fails the list as unavailable, naming content's reason, and returns none of it.
   */
  async standings(itemIds: readonly string[], context: { readonly correlationId: string }) {
    const found: ItemStanding[] = [];
    for (let at = 0; at < itemIds.length; at += this.content.batchBound) {
      const answered = await this.content.itemStanding.handle({ itemIds: itemIds.slice(at, at + this.content.batchBound) }, { principal: SYSTEM, correlationId: context.correlationId });
      if (!answered.ok) {
        return { ok: false as const, error: Object.freeze({ kind: 'Unavailable' as const, code: 'SOURCE_UNAVAILABLE', message: `content could not be read: ${answered.error.code}` }) };
      }
      found.push(...answered.value);
    }
    return { ok: true as const, value: found };
  }
}
