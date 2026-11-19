// selftest on a running stack (docs/specs/platform.md, criterion 7 and the document service's
// selftest): from a process that runs the backend's own documents client, so the positive
// control (a TCP connection to the backend's port, a lookup of localhost) is the backend's code
// on this machine, and the service checks itself and a child against the same targets.
//
//   node --disable-sigusr1 scripts/prod-build/selftest.ts <documents socket> <backend port> <database socket> <secrets folder>
//
// It prints the reply as JSON. The spec has the backend itself run the positive control; this
// runs the same code in a process of its own, outside the backend's server.
// Exit codes: 0 ok, 1 a problem, 2 a usage error.
import { createDocumentsClient } from '../../apps/backend/src/kit/documents-client.ts';

const [socket, port, databaseSocket, secrets] = process.argv.slice(2);
if (
  process.argv.length !== 6 ||
  socket === undefined ||
  databaseSocket === undefined ||
  secrets === undefined ||
  !/^\d+$/.test(port ?? '')
) {
  console.error(
    'usage: node scripts/prod-build/selftest.ts <documents socket> <backend port> <database socket> <secrets folder>',
  );
  process.exit(2);
}

const reply = await createDocumentsClient(socket).selftest({
  port: Number(port),
  databaseSocket,
  secrets,
});
console.log(JSON.stringify(reply, null, 2));
process.exit(reply.ok ? 0 : 1);
