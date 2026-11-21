import { cookies } from 'next/headers';
import { Screen } from '@/components/screen';

/** While the browser sends this cookie, the page fails on the server (e2e/errors.spec.ts). */
const FAIL_COOKIE = 'instante-e2e-fail';

// A fixture of the end-to-end build only (next.config.ts, INSTANTE_E2E_PAGES): a server error
// that goes away, so "Try again" can be seen to ask the server again and recover.
export default async function Recover() {
  if ((await cookies()).has(FAIL_COOKIE)) {
    throw new Error('a server error until its cookie goes, for the end-to-end tests');
  }
  return <Screen title="Recovered" />;
}
