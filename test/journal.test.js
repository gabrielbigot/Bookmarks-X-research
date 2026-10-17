import test from 'node:test';
import assert from 'node:assert/strict';
import { weekWindow, buildSubjects, assignTiers, weekStats, extractPageText, evidenceFor, parseArticle, parseBriefs, parseEditorial, cleanCitations, fallbackArticle, estimateCall, costOf, makeBibliography, citeHtml, sourcesLine, imagesOf, externalLinks } from '../src/lib/journal.js';
import { makeSnowflake, savedInfo } from '../src/lib/time.js';

const NOW = new Date(2026, 9, 16, 15).getTime();
const DAY = 86_400_000;
const tw = (id, text, daysAgo, extra = {}) => ({ id, name: 'N' + id, handle: extra.handle || 'h' + id, text, lang: 'en', createdAt: new Date(NOW - (daysAgo + 1) * DAY).toISOString(), sortIndex: makeSnowflake(NOW - daysAgo * DAY), links: extra.links || [], media: extra.media || [], stats: { likes: extra.likes || 0 }, ...extra });

test('fenêtre de la semaine : libellé, numéro, période précédente', () => {
  const w = weekWindow(NOW, 7);
  assert.equal(w.from, '2026-10-10'); assert.equal(w.to, '2026-10-16');
  assert.equal(w.label, 'du 10 au 16 octobre 2026');
  assert.equal(w.week, 42);
  assert.equal(w.prevFrom, '2026-10-03'); assert.equal(w.prevTo, '2026-10-09');
  assert.match(weekWindow(Date.UTC(2026, 10, 3, 12), 7).label, /^du 28 octobre au 3 novembre 2026$/);
});

test('sujets : regroupement, source principale en tête, rubriques sans doublon, paliers', () => {
  const items = [
    tw('1', 'we announced Jev 1.14 today', 1, { handle: 'typesafeai', likes: 100, media: [{ type: 'photo', url: 'https://img/1.jpg' }], links: ['https://typesafe.example/blog/jev-114', 'https://x.com/a/status/1'] }),
    tw('2', 'the @typesafeai team shipped Jev 1.14 with image support', 1, { handle: 'dotpem', likes: 900 }),
    tw('3', 'a robot arm demo', 2, { likes: 5 }),
    tw('4', 'old tweet', 20),
    tw('5', 'cooking pasta', 1),
  ];
  const sv = savedInfo(items, NOW);
  const o = (v) => Float32Array.from(v);
  const vecs = new Map([['1', o([1, 0.45, 0])], ['2', o([1, 0, 0])], ['3', o([0, 0, 1])], ['4', o([0, 1, 0])]]);
  const win = weekWindow(NOW, 7);
  const sections = [{ id: 'ia', name: 'Modèles d’IA', set: new Set(['1', '2', '4']) }, { id: 'robot', name: 'Robotique', set: new Set(['3', '1']) }];
  const subs = buildSubjects(items, { sv, sections, vecs, win, sim: 0.95, days: 7 });
  assert.equal(subs.length, 2, 'le tweet 1 n’apparaît que dans la première rubrique ; le tweet hors période est ignoré');
  const ia = subs.find((s) => s.section === 'ia');
  assert.equal(ia.members.length, 2);
  assert.equal(ia.rep.id, '1', 'l’annonce de la source (nommée par l’autre) passe devant le commentaire plus liké');
  assert.deepEqual(ia.images.map((i) => i.url), ['https://img/1.jpg']);
  assert.deepEqual(ia.links, ['https://typesafe.example/blog/jev-114']);
  const tiers = assignTiers(subs, { leads: 1, articles: 1, briefs: 5 });
  assert.equal(tiers.leads.length, 1); assert.equal(tiers.articles.length, 1); assert.equal(tiers.briefs.length, 0);
  assert.equal(tiers.leads[0].section, 'ia');
  const st = weekStats(items, { sv, sections, win });
  assert.equal(st.total, 4 - 1 + 0 === 3 ? 3 : st.total);
  assert.equal(st.dayKeys.length, 7);
  assert.ok(st.topAccounts.length > 0);
  assert.deepEqual(imagesOf({ media: [{ type: 'video', url: 'p.jpg', video: 'v.mp4' }] }).map((i) => i.video), [true]);
  assert.deepEqual(externalLinks({ links: ['https://t.co/x', 'https://blog.io/p/?a=1'], quoted: { links: ['https://x.com/q'] } }), ['https://blog.io/p/?a=1']);
});

test('page liée : texte principal, titre, image, coupe', () => {
  const html = '<html><head><title>Jev 1.14 — notes</title><meta property="og:image" content="https://i/x.png"></head><body><nav><p>Menu menu menu menu menu menu menu menu menu menu</p></nav><article><h2>Ce qui change dans cette version du modèle</h2><p>Le modèle accepte maintenant des images en entrée, en plus du texte et de la structure.</p><p>court</p><script>var x=1</script><p>Un contexte plus long est disponible pour les requêtes les plus volumineuses des utilisateurs.</p></article></body></html>';
  const p = extractPageText(html, { max: 120 });
  assert.equal(p.title, 'Jev 1.14 — notes'); assert.equal(p.image, 'https://i/x.png');
  assert.ok(p.text.includes('images en entrée') && !p.text.includes('Menu') && !p.text.includes('var x'));
  assert.equal(p.text.length <= 120, true); assert.equal(p.cut, true);
});

test('dossier de preuves, citations validées, sources numérotées', () => {
  const rep = tw('1', 'we announced Jev 1.14 today with image support', 1, { handle: 'typesafeai' });
  const other = tw('2', 'nice release', 1, { handle: 'dotpem', quoted: { handle: 'typesafeai', text: 'orig' } });
  const subject = { rep, members: [rep, other], links: ['https://blog.io/p', 'https://none.io/x'], sectionName: 'IA', firstDay: '2026-10-15', lastDay: '2026-10-15' };
  const pages = new Map([['https://blog.io/p', { title: 'Le billet', text: 'Le modèle lit les images.' }]]);
  const pack = evidenceFor(subject, pages);
  assert.deepEqual(pack.sources.map((s) => s.id), ['T1', 'T2', 'L1']);
  assert.match(pack.text, /\[T1\] @typesafeai.*COMPTE SOURCE PRINCIPALE/);
  assert.match(pack.text, /\[L1\] Page liée \(blog\.io\)/);
  assert.equal(cleanCitations('Phrase [T1,T9] et [L7] fin [L1].', new Set(['T1', 'L1'])), 'Phrase [T1] et fin [L1].');
  const a = parseArticle('```json\n{"title":"Jev 1.14 lit les images","dek":"Le modèle évolue [T1]","paragraphs":["TypeSafe annonce la version 1.14 avec la prise en charge des images [T1,L1].","Un second paragraphe suffisamment long pour être gardé [T2] [T9]."],"pull_quote":"we announced Jev 1.14 today","pull_source":"T1","key_points":["Images [L1]"]}\n```', pack);
  assert.equal(a.paragraphs.length, 2); assert.ok(!a.paragraphs[1].includes('T9')); assert.equal(a.pullSource, 'T1');
  assert.throws(() => parseArticle('{"title":"x","paragraphs":[]}', pack));
  const bib = makeBibliography();
  assert.equal(citeHtml('Fait [T1,L1] et [T2].', pack, bib), 'Fait <sup class="c">1,2</sup> et <sup class="c">3</sup>.');
  assert.match(sourcesLine({ dek: '', paragraphs: ['a [T1]'], points: [] }, pack, bib), /1\. @typesafeai/);
  assert.equal(bib.list.length, 3);
  const fb = fallbackArticle(subject, pack);
  assert.ok(fb.fallback && fb.paragraphs[0].includes('@typesafeai') && fb.paragraphs[0].includes('[T1]'));
  const bs = parseBriefs('{"briefs":[{"id":"a","title":"T","text":"Brève [T1] [T5]"},{"id":"zzz","text":"inconnue"}]}', new Map([['a', new Set(['T1'])]]));
  assert.equal(bs.size, 1); assert.equal(bs.get('a').text, 'Brève [T1]');
  const ed = parseEditorial('{"title":"Éd","paragraphs":["a","b"],"ideas":["1","2","3","4"],"week":[{"day":"2026-10-14","text":"x"},{"day":"mauvais","text":"y"}],"glossary":[{"term":"VLM","def":"modèle vision-langage"}]}');
  assert.equal(ed.ideas.length, 3); assert.equal(ed.week.length, 1); assert.equal(ed.glossary[0].term, 'VLM');
});

test('coûts : estimation et coût réel', () => {
  const prices = { priceInPerM: 1, priceOutPerM: 5 };
  const e = estimateCall(7000, 1000, prices);
  assert.equal(e.tin, 2300); assert.ok(Math.abs(e.dollars - (2300 / 1e6 + 5000 / 1e6)) < 1e-9);
  assert.equal(costOf({ cost: 0.0123 }, prices), 0.0123);
  assert.ok(Math.abs(costOf({ promptTokens: 1e6, completionTokens: 2e5 }, prices) - 2) < 1e-9);
});

import { searchMessages, parseFindings, splitSentences, verifyMessages, applyVerification } from '../src/lib/journal.js';
test('recherche web : seules les adresses réellement consultées sont retenues ; sources W dans le dossier', () => {
  const ann = [{ type: 'url_citation', url_citation: { url: 'https://ref.example/a?utm_source=x', title: 'Page A', content: 'Le modèle accepte des images.' } }, { url_citation: { url: 'https://b.example/post/', title: 'Page B', content: '' } }];
  const text = '```json\n{"findings":[{"fact":"Le modèle accepte des images.","url":"https://ref.example/a"},{"fact":"Un autre fait.","url":"https://ref.example/a?utm_medium=y"},{"fact":"Fait inventé.","url":"https://made.up/x"},{"fact":"Fait B.","url":"https://b.example/post"}]}\n```';
  const r = parseFindings(text, ann);
  assert.equal(r.sources.length, 2); assert.equal(r.rejected, 1);
  assert.equal(r.sources[0].host, 'ref.example'); assert.ok(r.sources[0].text.includes('Un autre fait.') && r.sources[0].text.includes('Extrait de la page'));
  assert.equal(parseFindings(text, []).noAnnotations, true);
  assert.equal(parseFindings('pas du json', ann).sources.length, 0);
  const rep = tw('1', 'we announced Jev 1.14 today', 1, { handle: 'typesafeai' });
  const subject = { rep, members: [rep], links: [], sectionName: 'IA', firstDay: '2026-10-15', lastDay: '2026-10-15' };
  assert.match(searchMessages(subject)[1].content, /@typesafeai/);
  const pack = evidenceFor(subject, new Map(), { web: r.sources });
  assert.deepEqual(pack.sources.map((s) => s.id), ['T1', 'W1', 'W2']);
  assert.match(pack.text, /\[W1\] Page web trouvée par recherche \(ref\.example\)/);
  assert.equal(cleanCitations('Fait [W1,W3] ok [W2].', new Set(['W1', 'W2'])), 'Fait [W1] ok [W2].');
  const bib = makeBibliography();
  assert.equal(citeHtml('Contexte [W1] et annonce [T1].', pack, bib), 'Contexte <sup class="c">1</sup> et annonce <sup class="c">2</sup>.');
  assert.match(sourcesLine({ dek: '', paragraphs: ['a [W1]'], points: [] }, pack, bib), /1\. ref\.example/);
});

test('citation mise en exergue : doit figurer mot pour mot dans un tweet', () => {
  const rep = tw('1', 'we announced Jev 1.14 today with image support', 1, { handle: 'typesafeai' });
  const pack = evidenceFor({ rep, members: [rep], links: [] });
  const art = (q) => parseArticle(JSON.stringify({ title: 'Titre assez long', dek: 'chapeau', paragraphs: ['Un paragraphe de plus de vingt caractères [T1].'], pull_quote: q, pull_source: 'T1' }), pack);
  assert.equal(art('« we announced Jev 1.14 today »').pull, 'we announced Jev 1.14 today');
  assert.equal(art('une citation inventée par le modèle').pull, '');
});

test('relecture : phrases non étayées retirées, réponse suspecte ignorée', () => {
  const article = { title: 't', dek: '', paragraphs: ['Première phrase soutenue [T1]. Deuxième phrase inventée sans source.', 'Un second paragraphe tout à fait soutenu par le dossier [T1].'], pull: '', points: [] };
  assert.deepEqual(splitSentences(article.paragraphs[0]), ['Première phrase soutenue [T1].', 'Deuxième phrase inventée sans source.']);
  const rep = tw('1', 'x', 1);
  const v = verifyMessages(article, evidenceFor({ rep, members: [rep], links: [] }));
  assert.deepEqual(v.lines.map((l) => l.id), ['0.0', '0.1', '1.0']);
  const r = applyVerification(article, v.lines, '{"results":[{"id":"0.1","supported":false},{"id":"0.0","supported":true}]}');
  assert.equal(r.removed, 1); assert.equal(r.article.paragraphs[0], 'Première phrase soutenue [T1].'); assert.equal(r.article.paragraphs.length, 2);
  const all = applyVerification(article, v.lines, '{"results":[{"id":"0.0","supported":false},{"id":"0.1","supported":false},{"id":"1.0","supported":false}]}');
  assert.equal(all.removed, 0); assert.equal(all.article, article);
  assert.equal(applyVerification(article, v.lines, 'n’importe quoi').removed, 0);
});

import { meanVec, matchVideos, bestPassages, splitTranscript, summaryMessages, parseSummary, reportageEvidence, reportageMessages, videoUrl } from '../src/lib/journal.js';
test('transcriptions : vidéos proches d’un sujet, passages, parties, résumé vérifié, dossier de reportage', () => {
  const o = (v) => Float32Array.from(v);
  const q = meanVec([o([1, 0, 0]), o([1, 0.2, 0])]);
  assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-6);
  assert.equal(meanVec([null]), null);
  const vids = new Map([
    ['yt:near', { k: 2, vecs: Float32Array.from([0, 1, 0, 0.9, 0.3, 0]) }],   // 2 passages (dim 3) : le 2e ressemble
    ['yt:far', { k: 1, vecs: Float32Array.from([0, 0, 1]) }],
    ['yt:old', { k: 1, vecs: Float32Array.from([1, 0, 0]) }],
  ]);
  assert.deepEqual(matchVideos(q, vids, { minSim: 0.55, eligible: new Set(['yt:near', 'yt:far']) }).map((m) => m.id), ['yt:near']);
  assert.deepEqual(matchVideos(q, vids, { minSim: 0.55 }).map((m) => m.id), ['yt:old', 'yt:near']);
  const chunks = [{ t: 0, text: 'intro' }, { t: 60, text: 'le sujet précis ici' }];
  const ps = bestPassages(chunks, vids.get('yt:near'), q, 1);
  assert.equal(ps.length, 1); assert.equal(ps[0].t, 60);
  assert.equal(videoUrl({ videoId: 'abc' }, 125.7), 'https://www.youtube.com/watch?v=abc&t=125s');
  const long = Array.from({ length: 100 }, (_, i) => ({ t: i * 30, text: 'x'.repeat(450) }));
  const parts = splitTranscript(long, { size: 9000, maxParts: 4 });
  assert.equal(parts.length, 4); assert.match(parts[0].text, /^\[0:00\] x+/);
  const part = { from: 600, to: 700, text: '[10:00] Le modèle lit les images et le texte ensemble, ce qui change beaucoup de choses pour les utilisateurs.\n[10:30] Autre chose.\n' };
  const video = { videoId: 'abc', text: 'Titre de la vidéo', name: 'Chaîne', durationText: '48:00' };
  assert.match(summaryMessages(video, part)[1].content, /de 10:00 à 11:40/);
  const sm = parseSummary('{"points":[{"t":600,"text":"Le modèle lit images et texte"},{"t":"x","text":"court"}],"quote":{"t":600,"text":"Le modèle lit les images et le texte ensemble, ce qui change beaucoup de choses pour les utilisateurs."}}', part);
  assert.equal(sm.points.length, 1); assert.ok(sm.quote);
  assert.equal(parseSummary('{"points":[],"quote":{"t":1,"text":"Une citation que la vidéo ne contient absolument pas du tout."}}', part).quote, null);
  const ev = reportageEvidence(video, [sm]);
  assert.equal(ev.sources[0].id, 'V1'); assert.match(ev.text, /\(10:00\) Le modèle lit images et texte/); assert.match(reportageMessages(video, ev)[0].content, /reportage/);
  const art = parseArticle(JSON.stringify({ title: 'Un reportage sur la vidéo du jour', dek: 'chapeau [V1]', paragraphs: ['Vers 10:00, la vidéo explique que le modèle lit images et texte [V1].'], pull_quote: 'Le modèle lit les images et le texte ensemble', pull_source: 'V1' }), ev);
  assert.equal(art.pullSource, 'V1'); assert.ok(art.pull.startsWith('Le modèle lit'));
  const rep = tw('1', 'we announced Jev', 1, { handle: 'typesafeai' });
  const pack = evidenceFor({ rep, members: [rep], links: [] }, new Map(), { videos: [{ video, passages: ps }] });
  assert.deepEqual(pack.sources.map((s) => s.id), ['T1', 'V1']);
  assert.match(pack.text, /\[V1\] Vidéo YouTube « Titre de la vidéo » \(Chaîne\) — extraits de la transcription : \[1:00\] le sujet précis ici/);
  assert.equal(citeHtml('Dit [V1].', pack, makeBibliography()), 'Dit <sup class="c">1</sup>.');
});
