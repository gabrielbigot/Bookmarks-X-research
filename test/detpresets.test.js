import test from 'node:test';
import assert from 'node:assert/strict';
import { DETECTOR_PRESETS } from '../src/lib/detpresets.js';

test('détecteurs prêts à l’emploi : les sept demandés, bien formés', () => {
  assert.equal(DETECTOR_PRESETS.length, 7);
  const names = DETECTOR_PRESETS.map((p) => p.name);
  assert.equal(new Set(names).size, 7, 'noms uniques');
  for (const wanted of [/Lancements de modèles/, /robots et robots open-source/, /Tests et analyses/, /qualité-prix/, /Économie de l/, /Réflexions sur l.IA en général/, /travail et entreprise/]) assert.ok(names.some((n) => wanted.test(n)), String(wanted));
  for (const p of DETECTOR_PRESETS) {
    assert.ok(p.desc.length > 30 && p.threshold > 0 && p.threshold < 1, p.name);
    assert.ok(p.examples.length >= 8 && new Set(p.examples).size === p.examples.length, p.name + ' : exemples variés');
    assert.ok(p.examples.every((x) => x.length > 20 && x.length < 200), p.name);
    assert.ok(p.examples.some((x) => /[éèàç]/.test(x)), p.name + ' : au moins un exemple en français');
  }
});
