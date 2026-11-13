import type { routes } from '@instante/contract';
import type { Handler, Handlers } from '../register-routes.ts';

export const ping: Handler<typeof routes.ping> = ({ clock }) => ({
  ok: true,
  at: clock.now().toISOString(),
});

/** One handler per route in the contract's `routes`; each later module adds its own. */
export const routeHandlers: Handlers<typeof routes> = { ping };
