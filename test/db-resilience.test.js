import test from 'node:test';
import assert from 'node:assert/strict';

// Faux IndexedDB : une connexion fermée lève « InvalidStateError : the database connection is closing » comme dans le navigateur
let opened = 0;
const mkDb = () => ({
  closed: false,
  objectStoreNames: { contains: () => true },
  createObjectStore() {},
  transaction() { if (this.closed) { const e = new Error("Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing."); e.name = 'InvalidStateError'; throw e; } return {}; },
  close() { this.closed = true; },
});
globalThis.indexedDB = { open() { const req = {}; setTimeout(() => { const db = mkDb(); opened++; req.result = db; req.onsuccess?.(); }); return req; } };
const { openDb, resetDb, isClosingError } = await import('../src/lib/db.js');

test('openDb : une connexion fermée par le navigateur est remplacée au lieu d’être réutilisée', async () => {
  const a = await openDb();
  assert.equal(await openDb(), a, 'la connexion est partagée tant qu’elle est valide');
  assert.equal(opened, 1);
  a.close(); // fermeture sans événement (cas « connection is closing »)
  const b = await openDb();
  assert.notEqual(b, a); assert.equal(opened, 2); assert.doesNotThrow(() => b.transaction('meta'));
});

test('openDb : fermeture inattendue (onclose) et changement de version (onversionchange)', async () => {
  const a = await openDb();
  a.onclose(); // le navigateur annonce la fermeture
  const b = await openDb();
  assert.notEqual(b, a);
  b.onversionchange(); // une autre version veut s'installer : on ferme et on s'écarte
  assert.equal(b.closed, true);
  const c = await openDb();
  assert.notEqual(c, b); assert.equal(c.closed, false);
  resetDb();
  assert.notEqual(await openDb(), c);
});

test('isClosingError reconnaît l’erreur affichée dans le panneau', () => {
  assert.ok(isClosingError(new Error("Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.")));
  assert.ok(isClosingError({ name: 'InvalidStateError', message: 'x' }));
  assert.ok(!isClosingError(new Error('HTTP 429')));
});
