/**
 * Registers the service worker (M6-51) and lets the app ask for a newer shell. Nothing here runs unless the browser has service workers;
 * where it has none, the app is simply online-only for its shell and still keeps every answer on the device.
 */
export interface ServiceWorkerHost {
  register(url: string): Promise<{ update(): Promise<unknown> }>;
}

export async function registerServiceWorker(host: ServiceWorkerHost | undefined, url = '/sw.js'): Promise<{ update(): Promise<unknown> } | null> {
  if (host === undefined) return null;
  try {
    return await host.register(url);
  } catch {
    return null;
  }
}
