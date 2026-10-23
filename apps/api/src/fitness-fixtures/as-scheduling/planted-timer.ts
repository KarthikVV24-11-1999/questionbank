/** A module that starts its own timer: the thing the scheduler's one port exists to prevent. */
export const start = (run: () => void): void => {
  setInterval(run, 1_000);
};
