// A child that writes, then waits for its stdin to end before writing again: its second write
// shows its stdin ended only once its parent let it.
process.stdout.write('before');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(' after');
});
