/**
 * Type-level assertions for {@link AuthRepository}. Nothing here runs: the
 * declarations are ambient and the file is imported by no one, so `tsc` is the
 * only thing that ever reads it.
 *
 * The assertions could equally live beside the runtime tests in
 * `auth.repository.test.ts`, which is typechecked as well; they sit in their
 * own module so the pin stays separate from the runtime suite.
 *
 * What it pins: the PasswordBinding on `createSession` is REQUIRED. Making it
 * optional again is what reopens the race the binding exists to close — a login
 * that read the old verifier, spent ~35ms in scrypt, and then inserted a 30-day
 * session under a password the operator had already rotated away from. Every
 * caller passes a binding today, so nothing else in the suite would notice the
 * parameter going optional; a `@ts-expect-error` that stops erroring is a
 * typecheck failure, which is exactly the notice needed.
 */
import type { AuthRepository, AuthSessionRecord } from "./auth.repository";

declare const repo: AuthRepository;
declare const record: AuthSessionRecord;

export function passwordBindingIsRequired(): void {
	// @ts-expect-error - omitting the binding must not compile.
	void repo.createSession(record);

	// The same call with a binding, so this file fails just as loudly if the
	// method is renamed or its other parameters change shape.
	void repo.createSession(record, { verifier: "v", params: "{}" });
}
