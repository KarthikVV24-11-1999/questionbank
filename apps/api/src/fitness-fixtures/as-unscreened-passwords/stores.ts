/** Stands in for the stores file, which may write the table. */
export const QUERY = `INSERT INTO identity.credential (user_id, hash) VALUES ($1, $2)`;
