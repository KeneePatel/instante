// A child that writes 4 MiB on stdout.
for (let i = 0; i < 4; i++) process.stdout.write(Buffer.alloc(1024 * 1024, 0x61));
