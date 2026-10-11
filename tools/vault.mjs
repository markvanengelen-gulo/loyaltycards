#!/usr/bin/env node
// Locks and unlocks the card list.
//
//   node tools/vault.mjs decrypt   -> writes cards.json from vault.js
//   node tools/vault.mjs encrypt   -> writes vault.js from cards.json
//
// Both ask for the PIN (or read it from the PIN environment variable).
// cards.json is the readable list; it is git-ignored and must stay out of the repo.
// Needs Node 18 or newer. No packages to install.

import { readFile, writeFile } from 'node:fs/promises';
import { webcrypto as crypto } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VAULT = path.join(root, 'vault.js');
const CARDS = path.join(root, 'cards.json');
const ITERATIONS = 600_000;
const FORMATS = ['CODE128', 'EAN13', 'UPC', 'ITF', 'CODE39', 'QR'];

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const unb64 = (text) => new Uint8Array(Buffer.from(text, 'base64'));

async function askPin() {
  if (process.env.PIN) return process.env.PIN;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pin = (await rl.question('PIN: ')).trim();
  rl.close();
  return pin;
}

async function keyFrom(pin, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function readVault() {
  const text = await readFile(VAULT, 'utf8');
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}

function check(cards) {
  if (!Array.isArray(cards)) throw new Error('cards.json must be a list of cards.');
  cards.forEach((card, i) => {
    const where = `Card ${i + 1} (${card.name || 'no name'})`;
    if (!card.name) throw new Error(`${where} needs a name.`);
    if (!card.value) throw new Error(`${where} needs a value.`);
    if (!FORMATS.includes(card.format)) {
      throw new Error(`${where} has format "${card.format}". Use one of: ${FORMATS.join(', ')}.`);
    }
  });
}

async function encrypt() {
  const cards = JSON.parse(await readFile(CARDS, 'utf8'));
  check(cards);
  const pin = await askPin();
  if (!/^\d{4,}$/.test(pin)) throw new Error('The PIN must be at least 4 digits.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(pin, salt, ITERATIONS);
  const data = new TextEncoder().encode(JSON.stringify(cards));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const vault = {
    v: 1,
    iter: ITERATIONS,
    pinLength: pin.length,
    salt: b64(salt),
    iv: b64(iv),
    ct: b64(new Uint8Array(sealed)),
  };
  await writeFile(VAULT, `window.VAULT = ${JSON.stringify(vault, null, 2)};\n`);
  console.log(`Locked ${cards.length} cards into vault.js`);
}

async function decrypt() {
  const vault = await readVault();
  const pin = await askPin();
  const key = await keyFrom(pin, unb64(vault.salt), vault.iter);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, key, unb64(vault.ct));
  } catch {
    throw new Error('That PIN did not unlock vault.js.');
  }
  const cards = JSON.parse(new TextDecoder().decode(plain));
  await writeFile(CARDS, JSON.stringify(cards, null, 2) + '\n');
  console.log(`Wrote ${cards.length} cards to cards.json (git-ignored; keep it out of the repo)`);
}

const command = process.argv[2];
try {
  if (command === 'encrypt') await encrypt();
  else if (command === 'decrypt') await decrypt();
  else {
    console.log('Usage: node tools/vault.mjs encrypt | decrypt');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
