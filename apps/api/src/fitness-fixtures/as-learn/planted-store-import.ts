// The package is not installed here, and must not be: the rule reads the import, not the module.
// @ts-expect-error TS2307
import { create } from 'zustand';

export const useStore = create(() => ({ n: 0 }));
