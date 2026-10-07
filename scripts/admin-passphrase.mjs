#!/usr/bin/env node
// scripts/admin-passphrase.mjs — make the value for LOCAL_PLAN_NAVIGATOR_ADMIN_PASSWORD_HASH.
//
//   npm run admin-passphrase              makes a new random passphrase and prints both
//   echo -n 'my passphrase' | npm run admin-passphrase -- --stdin
//
// Only the hash goes in the server's environment; keep the passphrase somewhere
// safe. Changing it signs every administrator out.
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../server/access.mjs';

let passphrase;
if (process.argv.includes('--stdin')) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  passphrase = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
} else {
  // Four groups of five from an unambiguous alphabet: about 100 bits, easy to type.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(20);
  passphrase = Array.from({ length: 4 }, (_, g) => Array.from({ length: 5 }, (_, i) => alphabet[bytes[g * 5 + i] % alphabet.length]).join('')).join('-');
  console.log(`passphrase: ${passphrase}`);
}
console.log(`LOCAL_PLAN_NAVIGATOR_ADMIN_PASSWORD_HASH=${hashPassword(passphrase)}`);
