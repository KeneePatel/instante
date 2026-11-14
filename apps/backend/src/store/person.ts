// The person-scoped store rule (docs/specs/platform.md, "Code style"; docs/threat-model.md):
// every store function that touches a per-person table takes the person's id, as a PersonId.
// A PersonId is branded, so a stray string (a route parameter, a row's id) can't stand in for
// one; only authentication makes them, from a verified account.

declare const brand: unique symbol;

export type PersonId = string & { readonly [brand]: 'PersonId' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** For authentication only: the account a verified token names. */
export function asPersonId(id: string): PersonId {
  if (!UUID.test(id)) throw new Error('asPersonId: not an account id');
  return id as PersonId;
}
