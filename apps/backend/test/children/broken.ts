// A child that fails, saying why on stderr.
process.stderr.write('could not read the document');
process.exitCode = 3;
