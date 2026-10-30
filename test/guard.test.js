import test from 'node:test';
import assert from 'node:assert/strict';
import { looksWiped, nextSeen, backupDue } from '../src/lib/guard.js';

test('looksWiped : chute brutale de l’effectif connu', () => {
  assert.equal(looksWiped(0, { n: 5000 }), true);
  assert.equal(looksWiped(900, { n: 5000 }), true);
  assert.equal(looksWiped(1100, { n: 5000 }), false, 'baisse modérée : normale');
  assert.equal(looksWiped(0, { n: 150 }), false, 'petite base : rien d’inquiétant');
  assert.equal(looksWiped(0, undefined), false, 'premier lancement');
});

test('nextSeen : suit la base, mais se fige quand elle semble vidée', () => {
  const seen = { n: 5000, at: 1 };
  assert.deepEqual(nextSeen(5200, seen, 9), { n: 5200, at: 9 });
  assert.equal(nextSeen(0, seen, 9), seen, 'l’alerte reste affichée jusqu’à la restauration');
  assert.equal(nextSeen(50, undefined, 9), undefined, 'base minuscule : rien à retenir');
  assert.deepEqual(nextSeen(300, undefined, 9), { n: 300, at: 9 });
});

test('backupDue : périodicité et garde-fous contre l’écrasement par une base vide', () => {
  const H = 3600_000, now = 100 * H;
  assert.deepEqual(backupDue({}, { now, hours: 24, n: 5000 }), { due: true, skip: null }, 'jamais sauvegardé');
  assert.deepEqual(backupDue({ lastBackup: { at: now - 3 * H, count: 5000 } }, { now, hours: 24, n: 5000 }), { due: false, skip: null }, 'récente');
  assert.equal(backupDue({ lastBackup: { at: now - 25 * H, count: 5000 } }, { now, hours: 24, n: 5100 }).due, true);
  assert.match(backupDue({ lastBackup: { at: now - 25 * H, count: 5000 }, seen: { n: 5000 } }, { now, hours: 24, n: 0 }).skip, /vidée/);
  assert.match(backupDue({ lastBackup: { at: now - 25 * H, count: 5000 } }, { now, hours: 24, n: 10 }).skip, /presque vide/);
  assert.match(backupDue({ lastBackup: { at: now - 25 * H, count: 5000 } }, { now, hours: 24, n: 2000 }).skip, /perdu plus de la moitié/);
  assert.equal(backupDue({ lastBackup: { at: now - 25 * H, count: 5000 } }, { now, hours: 24, n: 2000 }).due, false);
});
