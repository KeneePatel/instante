// A child that reports how it was started: its flags, its environment's names, and whether it
// has an IPC channel to its parent.
process.stdout.write(
  JSON.stringify({
    execArgv: process.execArgv,
    env: Object.keys(process.env),
    ipc: process.channel !== undefined,
    cwd: process.cwd(),
  }),
);
