/**
 * `Cache-Control: private, no-store` on every response this surface produces.
 *
 * `private` is doing real work here, unlike on the public widget surface. The
 * credential arrives in `x-api-key` as often as in `Authorization`, and a
 * shared HTTP cache does not treat a custom header as a credential the way it
 * treats `Authorization` — so a URL-keyed cache in front of this proxy could
 * serve one client's accounting to the next caller of the same URL. `no-store`
 * then keeps intermediaries from retaining the body at all.
 *
 * Applied to errors as much as to successes: a 401 or a namespace 404 is still
 * an answer about one specific credential.
 */
export const CLIENT_NO_STORE_HEADERS: Record<string, string> = {
	"Cache-Control": "private, no-store",
};
