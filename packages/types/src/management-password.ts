/**
 * Longest management password, in UTF-8 bytes. The login endpoint refuses to
 * hash anything longer (checked BEFORE scrypt runs), so a longer password could
 * be stored but never used to sign in.
 */
export const MAX_PASSWORD_BYTES = 1024;

/** Shortest password that may be stored as the management password. */
export const MIN_PASSWORD_LENGTH = 8;
