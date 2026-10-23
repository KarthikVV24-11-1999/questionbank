/** A deadline computed from the device's wall clock. */
export const remaining = (deadline: number): number => deadline - Date.now();
