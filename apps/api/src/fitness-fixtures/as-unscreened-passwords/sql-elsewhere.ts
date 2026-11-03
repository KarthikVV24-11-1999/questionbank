/** Planted: SQL that writes a credential, outside the stores file. */
export const QUERY = `UPDATE identity.credential SET hash = $2 WHERE user_id = $1`;
