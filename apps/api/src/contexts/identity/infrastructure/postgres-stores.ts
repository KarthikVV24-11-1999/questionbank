import type { Pool, PoolClient } from 'pg';
import type { StoredCredential } from '../domain/password-hash.js';
import type { OneTimeTokenPurpose } from '../domain/session-policy.js';
import type { User } from '../domain/user.js';
import type { CredentialStore, NewSession, OneTimeTokenStore, SessionRecord, SessionRevocation, SessionStore, UserStore, UserWithCredential } from '../application/ports.js';

/**
 * Identity's tables (M8-01). Every write that has to move together does so in one transaction: a credential that changes takes the user's sessions with it, a rotated
 * session is replaced and ended at once, a token is spent and the password changed together. A failure between the halves would leave a login standing that should not be.
 */
async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

interface UserRow {
  user_id: string;
  email: string;
  email_normalized: string;
  email_verified_at: Date | null;
  roles: string[];
  disabled_at: Date | null;
  created_at: Date;
  algorithm: 'scrypt' | null;
  n: number | null;
  r: number | null;
  p: number | null;
  key_length: number | null;
  salt: Buffer | null;
  hash: Buffer | null;
}

const USER_SELECT = `SELECT u.user_id, u.email, u.email_normalized, u.email_verified_at, u.roles, u.disabled_at, u.created_at,
                            c.algorithm, c.n, c.r, c.p, c.key_length, c.salt, c.hash
                       FROM identity.app_user u LEFT JOIN identity.credential c USING (user_id)`;

function toUser(row: UserRow): UserWithCredential {
  const user: User = Object.freeze({ userId: row.user_id, email: row.email, emailNormalized: row.email_normalized, emailVerifiedAt: row.email_verified_at, roles: Object.freeze([...row.roles]), disabledAt: row.disabled_at, createdAt: row.created_at });
  const credential: StoredCredential | null =
    row.algorithm === null || row.n === null || row.r === null || row.p === null || row.key_length === null || row.salt === null || row.hash === null
      ? null
      : { parameters: { algorithm: row.algorithm, n: row.n, r: row.r, p: row.p, keyLength: row.key_length }, salt: row.salt, hash: row.hash };
  return { user, credential };
}

const credentialColumns = (credential: StoredCredential) => [credential.parameters.algorithm, credential.parameters.n, credential.parameters.r, credential.parameters.p, credential.parameters.keyLength, Buffer.from(credential.salt), Buffer.from(credential.hash)];

export class PostgresUserStore implements UserStore {
  constructor(private readonly pool: Pool) {}

  async findByEmail(emailNormalized: string): Promise<UserWithCredential | null> {
    const { rows } = await this.pool.query<UserRow>(`${USER_SELECT} WHERE u.email_normalized = $1`, [emailNormalized]);
    return rows[0] === undefined ? null : toUser(rows[0]);
  }

  async findById(userId: string): Promise<UserWithCredential | null> {
    const { rows } = await this.pool.query<UserRow>(`${USER_SELECT} WHERE u.user_id = $1`, [userId]);
    return rows[0] === undefined ? null : toUser(rows[0]);
  }

  async create(user: User, credential: StoredCredential): Promise<boolean> {
    return inTransaction(this.pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO identity.app_user (user_id, email, email_normalized, roles, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (email_normalized) DO NOTHING`,
        [user.userId, user.email, user.emailNormalized, [...user.roles], user.createdAt],
      );
      if (inserted.rowCount === 0) return false;
      await client.query(`INSERT INTO identity.credential (user_id, algorithm, n, r, p, key_length, salt, hash, changed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [user.userId, ...credentialColumns(credential), user.createdAt]);
      return true;
    });
  }

  async markEmailVerified(userId: string, at: Date): Promise<void> {
    await this.pool.query('UPDATE identity.app_user SET email_verified_at = COALESCE(email_verified_at, $2) WHERE user_id = $1', [userId, at]);
  }

  async rehash(userId: string, credential: StoredCredential, at: Date): Promise<void> {
    await this.pool.query('UPDATE identity.credential SET algorithm = $2, n = $3, r = $4, p = $5, key_length = $6, salt = $7, hash = $8, changed_at = $9 WHERE user_id = $1', [userId, ...credentialColumns(credential), at]);
  }
}

interface SessionRow {
  session_id: string;
  user_id: string;
  token_hash: Buffer;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  rotated_from: string | null;
}

const insertSession = (client: PoolClient, session: NewSession) =>
  client.query(
    `INSERT INTO identity.session (session_id, user_id, token_hash, created_at, last_seen_at, expires_at, rotated_from) VALUES ($1, $2, $3, $4, $4, $5, $6)`,
    [session.sessionId, session.userId, Buffer.from(session.tokenHash), session.createdAt, session.expiresAt, session.rotatedFrom],
  );

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly pool: Pool) {}

  async insertWithinLimit(session: NewSession, maxLive: number): Promise<{ readonly revokedForLimit: number }> {
    return inTransaction(this.pool, async (client) => {
      // one login at a time per user, so two logins cannot both see room
      await client.query('SELECT 1 FROM identity.app_user WHERE user_id = $1 FOR UPDATE', [session.userId]);
      await insertSession(client, session);
      const revoked = await client.query(
        `WITH live AS (
           SELECT session_id, row_number() OVER (ORDER BY created_at DESC, session_id DESC) AS newest
             FROM identity.session WHERE user_id = $1 AND revoked_at IS NULL)
         UPDATE identity.session SET revoked_at = $2, revoked_reason = 'device_limit'
          WHERE session_id IN (SELECT session_id FROM live WHERE newest > $3)`,
        [session.userId, session.createdAt, maxLive],
      );
      return { revokedForLimit: revoked.rowCount ?? 0 };
    });
  }

  async findByTokenHash(tokenHash: Uint8Array): Promise<SessionRecord | null> {
    const { rows } = await this.pool.query<SessionRow>(
      'SELECT session_id, user_id, token_hash, created_at, last_seen_at, expires_at, revoked_at, rotated_from FROM identity.session WHERE token_hash = $1',
      [Buffer.from(tokenHash)],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { sessionId: row.session_id, userId: row.user_id, tokenHash: row.token_hash, createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: row.expires_at, revokedAt: row.revoked_at, rotatedFrom: row.rotated_from };
  }

  async touch(sessionId: string, at: Date): Promise<void> {
    await this.pool.query('UPDATE identity.session SET last_seen_at = $2 WHERE session_id = $1 AND revoked_at IS NULL', [sessionId, at]);
  }

  async revoke(sessionId: string, reason: SessionRevocation, at: Date): Promise<boolean> {
    const done = await this.pool.query('UPDATE identity.session SET revoked_at = $2, revoked_reason = $3 WHERE session_id = $1 AND revoked_at IS NULL', [sessionId, at, reason]);
    return (done.rowCount ?? 0) > 0;
  }

  async rotate(oldSessionId: string, replacement: NewSession, at: Date): Promise<boolean> {
    return inTransaction(this.pool, async (client) => {
      const ended = await client.query(`UPDATE identity.session SET revoked_at = $2, revoked_reason = 'rotated' WHERE session_id = $1 AND revoked_at IS NULL AND expires_at > $2`, [oldSessionId, at]);
      if (ended.rowCount === 0) return false;
      await insertSession(client, replacement);
      return true;
    });
  }
}

export class PostgresOneTimeTokenStore implements OneTimeTokenStore {
  constructor(private readonly pool: Pool) {}

  async issue(token: { readonly tokenId: string; readonly userId: string; readonly purpose: OneTimeTokenPurpose; readonly tokenHash: Uint8Array; readonly createdAt: Date; readonly expiresAt: Date }): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      await client.query(`UPDATE identity.one_time_token SET superseded_at = $3 WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL AND superseded_at IS NULL`, [token.userId, token.purpose, token.createdAt]);
      await client.query(
        `INSERT INTO identity.one_time_token (token_id, user_id, purpose, token_hash, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [token.tokenId, token.userId, token.purpose, Buffer.from(token.tokenHash), token.createdAt, token.expiresAt],
      );
    });
  }

  async consume(tokenHash: Uint8Array, purpose: OneTimeTokenPurpose, at: Date): Promise<{ readonly userId: string } | null> {
    return consumeOn(this.pool, tokenHash, purpose, at);
  }
}

const consumeOn = async (db: Pool | PoolClient, tokenHash: Uint8Array, purpose: OneTimeTokenPurpose, at: Date): Promise<{ readonly userId: string } | null> => {
  const { rows } = await db.query<{ user_id: string }>(
    `UPDATE identity.one_time_token SET used_at = $3
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND superseded_at IS NULL AND expires_at > $3
      RETURNING user_id`,
    [Buffer.from(tokenHash), purpose, at],
  );
  return rows[0] === undefined ? null : { userId: rows[0].user_id };
};

const replaceCredential = (client: PoolClient, userId: string, credential: StoredCredential, at: Date) =>
  client.query('UPDATE identity.credential SET algorithm = $2, n = $3, r = $4, p = $5, key_length = $6, salt = $7, hash = $8, changed_at = $9 WHERE user_id = $1', [userId, ...credentialColumns(credential), at]);

const revokeSessions = async (client: PoolClient, userId: string, at: Date, reason: SessionRevocation, except: string | null): Promise<number> =>
  (
    await client.query(`UPDATE identity.session SET revoked_at = $2, revoked_reason = $3 WHERE user_id = $1 AND revoked_at IS NULL AND ($4::uuid IS NULL OR session_id <> $4::uuid)`, [userId, at, reason, except])
  ).rowCount ?? 0;

/** A password that changes makes every recovery code issued before it worthless. */
const supersedeRecoveryTokens = (client: PoolClient, userId: string, at: Date) =>
  client.query(`UPDATE identity.one_time_token SET superseded_at = $2 WHERE user_id = $1 AND purpose = 'password_recovery' AND used_at IS NULL AND superseded_at IS NULL`, [userId, at]);

export class PostgresCredentialStore implements CredentialStore {
  constructor(private readonly pool: Pool) {}

  async replaceAndRevoke(change: { readonly userId: string; readonly credential: StoredCredential; readonly at: Date; readonly exceptSessionId: string | null; readonly reason: SessionRevocation }): Promise<{ readonly revoked: number }> {
    return inTransaction(this.pool, async (client) => {
      await replaceCredential(client, change.userId, change.credential, change.at);
      const revoked = await revokeSessions(client, change.userId, change.at, change.reason, change.exceptSessionId);
      await supersedeRecoveryTokens(client, change.userId, change.at);
      return { revoked };
    });
  }

  async resetWithToken(change: { readonly tokenHash: Uint8Array; readonly credential: StoredCredential; readonly at: Date }): Promise<{ readonly userId: string; readonly revoked: number } | null> {
    return inTransaction(this.pool, async (client) => {
      const spent = await consumeOn(client, change.tokenHash, 'password_recovery', change.at);
      if (spent === null) return null;
      await replaceCredential(client, spent.userId, change.credential, change.at);
      const revoked = await revokeSessions(client, spent.userId, change.at, 'password_reset', null);
      await supersedeRecoveryTokens(client, spent.userId, change.at);
      return { userId: spent.userId, revoked };
    });
  }

  async revokeAll(userId: string, at: Date, reason: SessionRevocation): Promise<number> {
    return inTransaction(this.pool, (client) => revokeSessions(client, userId, at, reason, null));
  }
}
