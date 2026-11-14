// A child that never ends on its own while its parent lives. Orphaned, as when a failed test's
// worker exits before its kill comes, it ends itself, so no failed run leaves one behind.
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) process.exit(1);
}, 200);
