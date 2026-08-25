#!/usr/bin/env node

const { createPasswordHash } = require('../dist/security/SharedAdminAuth.js');

const chunks = [];
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', async () => {
  const password = chunks.join('').replace(/[\r\n]+$/, '');
  if (!password) {
    console.error('Passa la password tramite standard input; non inserirla negli argomenti della shell.');
    process.exitCode = 1;
    return;
  }
  try {
    process.stdout.write(`${await createPasswordHash(password)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
});

if (process.stdin.isTTY) {
  console.error('Passa la password tramite standard input; non inserirla negli argomenti della shell.');
  process.exitCode = 1;
  process.stdin.pause();
}
