export interface User {
  readonly userId: string;
  readonly email: string;
  readonly emailNormalized: string;
  readonly emailVerifiedAt: Date | null;
  readonly roles: readonly string[];
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
}
