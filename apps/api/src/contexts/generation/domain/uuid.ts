/**
 * The one definition of "is an identifier", shared by everything in this
 * context that must agree with content on it. Content stores the model version,
 * prompt version and run as `uuid`, so a pin member that is not one is a pin no
 * draft can carry — better refused where it is made than where it is used.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
