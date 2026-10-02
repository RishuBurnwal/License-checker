/**
 * Type declaration for the plain-JS env-seed helper so TypeScript test files
 * (worker/test/ensure-master-password-env.test.ts) can import it under
 * noImplicitAny without enabling allowJs. Mirrors the runtime export in
 * ./ensure-master-password-env.mjs.
 */

/**
 * Appends ADMIN_MASTER_PASSWORD="master" to the given .dev.vars file when the
 * key is absent. Returns true when a line was appended, false on a no-op.
 */
export function ensureMasterPasswordEnv(devVarsPath: string): boolean;
