import { z } from 'zod';
import { defineRoute } from './define-route.ts';

export const PingResponseSchema = z.object({ ok: z.literal(true), at: z.iso.datetime() });

/** The routes every environment serves. Each later module adds its own here. */
export const routes = {
  ping: defineRoute({
    method: 'GET',
    path: '/api/ping',
    auth: 'public',
    response: PingResponseSchema,
    errors: [],
  }),
} as const;
