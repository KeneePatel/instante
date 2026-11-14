// A child that writes `bytes` of `text` on one stream, `times` times with a pause between: by
// default once, 64 MiB and one byte of 'a' on stdout, one past the service's limit on a result.
const [bytes = String(64 * 1024 * 1024 + 1), stream = 'stdout', text = 'a', times = '1'] =
  process.argv.slice(2);
const out = stream === 'stderr' ? process.stderr : process.stdout;
for (let i = 0; i < Number(times); i++) {
  // The pause lets the parent read each write on its own.
  if (i > 0) await new Promise((resolve) => setTimeout(resolve, 100));
  out.write(Buffer.alloc(Number(bytes), text));
}
