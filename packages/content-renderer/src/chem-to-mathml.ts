/**
 * Chemical **notation** → MathML (DEC-6).
 *
 * Formulae, charges, states, arrows and stoichiometry — the things JEE/NEET
 * chemistry items overwhelmingly need — through the same MathML pipeline as
 * mathematics, so a screen reader meets one kind of markup and the parity
 * check has one kind of output to compare.
 *
 * **Chemical *structures* are deliberately out of scope** (DEC-6, debt D19).
 * Benzene rings, reaction schemes and mechanism arrows are authored as
 * `MediaAsset` diagrams with mandatory alt text and long descriptions. A
 * notation string that is asking for a structure is **refused with a reason
 * naming the diagram affordance**, rather than rendered as something broken —
 * a half-drawn ring is worse than an honest "use a diagram asset", because
 * only one of the two tells the author what to do next.
 *
 * Deterministic by construction: a pure function of the source string.
 */

export type ChemMLResult =
  | { readonly ok: true; readonly mathml: string }
  | { readonly ok: false; readonly reason: string; readonly useDiagramAsset: boolean };

/** The arrows a reaction uses. Longest first, so `<=>` never matches as `<`. */
const ARROWS: readonly (readonly [string, string])[] = Object.freeze([
  ['<=>>', '⇌'],
  ['<<=>', '⇌'],
  ['<=>', '⇌'],
  ['->', '→'],
  ['<-', '←'],
  ['=>', '⇒'],
]);

/** State symbols, set upright and parenthesised as chemistry writes them. */
const STATES = new Set(['s', 'l', 'g', 'aq']);

/**
 * Markers that mean somebody is drawing a structure rather than writing a
 * formula. Naming them is what makes the refusal actionable.
 */
const STRUCTURE_MARKERS: readonly (readonly [RegExp, string])[] = Object.freeze([
  [/\\chemfig\b/u, 'a \\chemfig structure'],
  [/\\smiles\b/u, 'a SMILES structure'],
  [/(?:^|[^A-Za-z])[cC]1(?:cc|CC)/u, 'a ring closure written in SMILES'],
  [/\{\s*-\s*\[/u, 'a bond-angle drawing'],
  [/[-=#]\s*\[[^\]]*\]/u, 'a bond with an explicit angle'],
]);

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Strips a `\ce{...}` wrapper, which is how chemistry is usually authored. */
function unwrap(source: string): string | undefined {
  const match = /^\s*\\ce\s*\{([\s\S]*)\}\s*$/u.exec(source);
  return match === null ? undefined : (match[1] as string);
}

interface Emitter {
  readonly parts: string[];
}

function emitFormula(emitter: Emitter, token: string): boolean {
  let index = 0;
  let emitted = false;

  while (index < token.length) {
    const char = token[index] as string;

    // An element symbol: one capital, then lowercase letters.
    if (/[A-Z]/u.test(char)) {
      let symbol = char;
      index += 1;
      while (index < token.length && /[a-z]/u.test(token[index] as string)) {
        symbol += token[index] as string;
        index += 1;
      }

      // Digits after a symbol are ambiguous: in `H2O` they are a subscript, in
      // `Ca2+` they are the magnitude of a charge. What disambiguates is
      // whether a sign follows them immediately — so the lookahead decides,
      // and a charge that also needs a subscript is written with an explicit
      // `^`, as `SO4^2-`.
      let count = '';
      const digits = /^[0-9]+/u.exec(token.slice(index))?.[0] ?? '';
      const signFollowsDigits = /^[0-9]+[+-]/u.test(token.slice(index));
      if (digits !== '' && !signFollowsDigits) {
        count = digits;
        index += digits.length;
      }

      let charge = '';
      const explicit = /^\^\{?(\d*)([+-])\}?/u.exec(token.slice(index));
      const bare = /^(\d*)([+-])/u.exec(token.slice(index));
      const chargeMatch = explicit ?? bare;
      if (chargeMatch !== null) {
        charge = `${chargeMatch[1] as string}${chargeMatch[2] as string}`;
        index += chargeMatch[0].length;
      }

      const base = `<mi mathvariant="normal">${symbol}</mi>`;
      if (count !== '' && charge !== '') {
        emitter.parts.push(`<msubsup>${base}<mn>${count}</mn><mo>${escapeXml(charge)}</mo></msubsup>`);
      } else if (count !== '') {
        emitter.parts.push(`<msub>${base}<mn>${count}</mn></msub>`);
      } else if (charge !== '') {
        emitter.parts.push(`<msup>${base}<mo>${escapeXml(charge)}</mo></msup>`);
      } else {
        emitter.parts.push(base);
      }
      emitted = true;
      continue;
    }

    // A leading stoichiometric coefficient.
    if (/[0-9]/u.test(char)) {
      let digits = char;
      index += 1;
      while (index < token.length && /[0-9]/u.test(token[index] as string)) {
        digits += token[index] as string;
        index += 1;
      }
      emitter.parts.push(`<mn>${digits}</mn>`);
      emitted = true;
      continue;
    }

    if (char === '(' || char === ')') {
      emitter.parts.push(`<mo>${char}</mo>`);
      index += 1;
      emitted = true;
      continue;
    }

    if (char === '.') {
      // A hydrate dot, as in CuSO4.5H2O.
      emitter.parts.push('<mo>⋅</mo>');
      index += 1;
      emitted = true;
      continue;
    }

    return false;
  }

  return emitted;
}

/**
 * Converts chemical notation to a MathML fragment.
 *
 * `useDiagramAsset` on a refusal is what the affordance keys on: it separates
 * "this is malformed" from "this is a structure, and structures are diagrams".
 */
export function chemToMathML(notation: string): ChemMLResult {
  const source = unwrap(notation) ?? notation;
  if (source.trim().length === 0) {
    return { ok: false, reason: 'the notation is empty', useDiagramAsset: false };
  }

  for (const [pattern, description] of STRUCTURE_MARKERS) {
    if (pattern.test(source)) {
      return {
        ok: false,
        reason: `${description} is a chemical structure, not notation — author it as a diagram asset with alt text and a long description (DEC-6)`,
        useDiagramAsset: true,
      };
    }
  }

  const emitter: Emitter = { parts: [] };
  const tokens = source.trim().split(/\s+/u);

  for (const token of tokens) {
    const arrow = ARROWS.find(([symbol]) => symbol === token);
    if (arrow !== undefined) {
      emitter.parts.push(`<mo>${arrow[1]}</mo>`);
      continue;
    }

    if (token === '+') {
      emitter.parts.push('<mo>+</mo>');
      continue;
    }

    const state = /^\(([a-z]{1,2})\)$/u.exec(token);
    if (state !== null && STATES.has(state[1] as string)) {
      emitter.parts.push(`<mo>(</mo><mi mathvariant="normal">${state[1] as string}</mi><mo>)</mo>`);
      continue;
    }

    // A formula may carry a trailing state, as in `H2O(l)`.
    const trailingState = /^(.*?)\(([a-z]{1,2})\)$/u.exec(token);
    if (trailingState !== null && STATES.has(trailingState[2] as string)) {
      if (!emitFormula(emitter, trailingState[1] as string)) {
        return { ok: false, reason: `"${token}" is not chemical notation`, useDiagramAsset: false };
      }
      emitter.parts.push(`<mo>(</mo><mi mathvariant="normal">${trailingState[2] as string}</mi><mo>)</mo>`);
      continue;
    }

    if (!emitFormula(emitter, token)) {
      return { ok: false, reason: `"${token}" is not chemical notation`, useDiagramAsset: false };
    }
  }

  return { ok: true, mathml: emitter.parts.join('') };
}
