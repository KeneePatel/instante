import { openSync } from 'node:fs';

// A stand-in for `selftest`'s child that keeps `input` open: a regular file beyond its own
// descriptors, which the service's lsof check must find. It reports nothing that parses, and
// waits, as selftest's child does, for its stdin to end.
const fd = openSync('input', 'r');
process.stdout.write(`holding ${String(fd)}`);
process.stdin.resume();
