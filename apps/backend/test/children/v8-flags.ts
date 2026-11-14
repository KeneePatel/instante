import { readdirSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

// A child that turns on V8's optimiser traces, which V8 writes itself, outside the permission
// model, to a file it names in its own folder; then makes V8 optimise a function, and reports
// what its folder holds if it got that far.
setFlagsFromString('--trace-turbo');
setFlagsFromString('--trace-turbo-cfg-file=chosen.txt');
const hot = (x: number) => (x * 31 + 7) ^ (x >> 1);
let sum = 0;
for (let i = 0; i < 3_000_000; i++) sum += hot(i);
process.stdout.write(JSON.stringify({ sum, files: readdirSync('.') }));
