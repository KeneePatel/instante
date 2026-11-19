// The database's socket in a scratch INSTANTE_HOME's run/ folder, relayed to the Postgres on
// 127.0.0.1:5432, for scripts/prod-build-check.sh: production connects to its database only
// through $INSTANTE_HOME/run, and CI's Postgres is a service container reached over TCP.
//
//   node --disable-sigusr1 scripts/prod-build/pg-relay.ts <socket>
//
// Test scaffolding only: Postgres sees a TCP connection, so its rules for socket connections
// aren't what the check tests (the macOS job's real cluster is). It never connects elsewhere.
// It stops on TERM. Exit codes: 0 stopped, 1 couldn't listen, 2 a usage error.
import { connect, createServer } from 'node:net';

const socket = process.argv[2];
if (socket === undefined || process.argv.length !== 3) {
  console.error('usage: node scripts/prod-build/pg-relay.ts <socket>');
  process.exit(2);
}

const server = createServer((client) => {
  const upstream = connect(5432, '127.0.0.1');
  client.pipe(upstream).pipe(client);
  client.on('error', () => {
    upstream.destroy();
  });
  upstream.on('error', () => {
    client.destroy();
  });
});
server.on('error', (error) => {
  console.error(`pg-relay: ${String(error)}`);
  process.exit(1);
});
server.listen(socket, () => {
  console.log(`pg-relay: ${socket} to 127.0.0.1:5432`);
});
process.on('SIGTERM', () => {
  server.close(() => {
    process.exit(0);
  });
});
