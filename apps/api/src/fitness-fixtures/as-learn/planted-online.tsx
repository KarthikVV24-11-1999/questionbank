/** A second source for "am I synced". */
export const Banner = () => <p>{navigator.onLine ? 'Online' : 'Offline'}</p>;
