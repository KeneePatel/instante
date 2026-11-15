import { readFileSync } from 'node:fs';

// A child that writes out the file named in its argument, or why it couldn't read it.
const file = process.argv[2] ?? '';
try {
  process.stdout.write(readFileSync(file, 'utf8'));
} catch (error) {
  process.stdout.write(String((error as NodeJS.ErrnoException).code));
}
