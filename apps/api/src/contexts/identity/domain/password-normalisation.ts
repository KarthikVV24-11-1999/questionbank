/**
 * The one form a password is compared and hashed in (M8-11). The same characters typed on two keyboards are one password, so a password is put in NFKC before anything reads it:
 * the hasher derives from this form, and the check against known passwords looks this form up. A check that compared a different form would miss a match the hash would have made
 * (a full-width `ｐａｓｓｗｏｒｄ１２３４` and `password1234` are the same password to the hasher), and it would be a second place to change when the form does.
 */
export function normalisePassword(raw: string): string {
  return raw.normalize('NFKC');
}
