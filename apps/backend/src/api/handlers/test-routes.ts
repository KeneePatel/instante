import { createHash } from 'node:crypto';
import type { testRoutes } from '@instante/contract';
import type { Handlers } from '../register-routes.ts';

// The test-only routes that prove the walking skeleton's checks (docs/specs/platform.md).
// They're registered only with INSTANTE_ENV=test.

export const testRouteHandlers: Handlers<typeof testRoutes> = {
  userOnly: () => ({ ok: true }),

  echo: ({ body, request }) => ({
    authorizationSha256:
      request.authorization === undefined
        ? null
        : createHash('sha256').update(request.authorization).digest('hex'),
    cookieArrived: request.cookieArrived,
    bodyBytes: body.byteLength,
  }),

  // Sends nothing at all, not even headers, until it's done.
  slow: async ({ query, sleep }) => {
    await sleep(query.seconds * 1000);
    return { ok: true };
  },

  filePdf: () => FIXTURE_PDF,
};

/** A one-page PDF with a correct cross-reference table, built here so src/ needs nothing
 * from test/. */
export const FIXTURE_PDF: Uint8Array = buildPdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>',
]);

function buildPdf(objects: string[]): Uint8Array {
  let text = '%PDF-1.7\n';
  const offsets = objects.map((object, i) => {
    const offset = text.length;
    text += `${String(i + 1)} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = text.length;
  text += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) text += `${String(offset).padStart(10, '0')} 00000 n \n`;
  text += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\n`;
  text += `startxref\n${String(xref)}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}
