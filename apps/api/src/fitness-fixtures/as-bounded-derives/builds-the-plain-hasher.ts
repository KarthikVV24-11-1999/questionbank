declare class ScryptPasswordHasher {}

/** Planted: a plain hasher, not handed to the bounded one. */
export const plain = new ScryptPasswordHasher();
