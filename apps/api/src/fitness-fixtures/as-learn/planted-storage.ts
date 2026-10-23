/** An answer written to the disk by a component, around the engine's log. */
export const remember = (answer: string): void => {
  window.localStorage.setItem('answer', answer);
};
