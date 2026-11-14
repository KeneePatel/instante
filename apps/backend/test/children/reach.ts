import { readFileSync } from 'node:fs';

// A child that reports, for each path in its arguments, whether it can read it: 'read', or the
// error's code.
process.stdout.write(
  JSON.stringify(
    process.argv.slice(2).map((file) => {
      try {
        readFileSync(file);
        return 'read';
      } catch (error) {
        return (error as NodeJS.ErrnoException).code;
      }
    }),
  ),
);
