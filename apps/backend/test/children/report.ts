import { fstatSync, statSync } from 'node:fs';

// A child that reports how it was started: its flags, its environment's names, whether it has an
// IPC channel to its parent, its working folder, what its standard streams are, how many bytes
// arrive on stdin before it ends, and the mode of `input` in its folder.

const kind = (fd: number) => {
  const stat = fstatSync(fd);
  if (stat.isSocket()) return 'socket';
  if (stat.isFIFO()) return 'pipe';
  return stat.isCharacterDevice() ? 'device' : 'other';
};

const inputMode = () => {
  try {
    return (statSync('input').mode & 0o777).toString(8);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
};

let stdin = 0;
process.stdin.on('data', (chunk: Buffer) => (stdin += chunk.length));
process.stdin.on('end', () => {
  process.stdout.write(
    JSON.stringify({
      execArgv: process.execArgv,
      env: Object.keys(process.env),
      ipc: process.channel !== undefined,
      cwd: process.cwd(),
      streams: [0, 1, 2].map(kind),
      stdin,
      input: inputMode(),
    }),
  );
});
