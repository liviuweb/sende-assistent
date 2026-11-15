// =====================================================================
// Oberfläche des Sende-Assistenten
// =====================================================================
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, html = '') => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (html) e.innerHTML = html; return e; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtZeit = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtHms = (ms) => { const s = Math.floor(ms / 1000); return [s / 3600, (s / 60) % 60, s % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':'); };

const Z = {
  roh: null, obs: null, fake: false, os: 'windows', qualitaet: '1080p60',
  gefunden: { kamera: { geraete: [] }, mikro: { geraete: [] } },
  kameras: [], mikros: [], szenen: [], vorlagen: new Set(['Bild im Bild unten rechts', 'Zwei Drittel / Drittel']),
  grafik: null, handy: null, start: 0, setupEnde: 0, liveStart: 0, schnitte: 0, befehle: 0, filter: 0,
  program: null, schritt: 0, demoBackup: {},
};
const TEST = new URLSearchParams(location.search);

// ---------- Protokoll ----------
function kurz(t, d) {
  if (!d) return '';
  const teile = [d.sceneName, d.inputName, d.sourceName, d.filterName, d.transitionName].filter(Boolean);
  if (d.inputKind) teile.push(d.inputKind);
  if (d.filterKind) teile.push(d.filterKind);
  if (t === 'SetVideoSettings') teile.push(`${d.outputWidth}×${d.outputHeight} @ ${d.fpsNumerator}`);
  if (t === 'SetSceneItemTransform') { const x = d.sceneItemTransform; teile.push(`#${d.sceneItemId} ${x.boundsWidth}×${x.boundsHeight} @ ${x.positionX},${x.positionY}`); }
  if (t === 'SetInputMute') teile.push(d.inputMuted ? 'stumm' : 'an');
  if (t === 'SetStreamServiceSettings') teile.push(d.streamServiceSettings.server);
  return teile.join(' · ');
}
function logGruppe(text) { const d = el('div', { class: 'grp' }, '▸ ' + esc(text)); $('log').append(d); $('log').scrollTop = 1e9; }
function mitProtokoll(roh) {
  return {
    isFake: !!roh.isFake,
    on: (e, f) => roh.on(e, f), off: (e, f) => roh.off(e, f),
    async call(t, d) {
      const t0 = performance.now(); const zeit = new Date().toLocaleTimeString('de-DE', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0').slice(0, 2);
      const z = el('div', { class: 'e' }, `<span class="t">${zeit}</span><span class="r"><b>${esc(t)}</b> <i>${esc(kurz(t, d))}</i></span><span class="s">…</span>`);
      $('log').append(z); $('log').scrollTop = 1e9;
      Z.befehle++; $('nBefehle').textContent = Z.befehle; $('hBefehle').textContent = Z.befehle;
      try { const r = await roh.call(t, d); z.querySelector('.s').outerHTML = `<span class="ok">✓ ${Math.round(performance.now() - t0)} ms</span>`; return r; }
      catch (e) { z.querySelector('.s').outerHTML = `<span class="no">✗ ${esc(e.code || '')}</span>`; z.title = e.message; throw e; }
    },
  };
}

// ---------- Navigation ----------
function zeige(n) {
  Z.schritt = n;
  document.querySelectorAll('section.schritt').forEach((s) => s.classList.toggle('aktiv', +s.dataset.s === n));
  document.querySelectorAll('#schritte li').forEach((l) => { l.classList.toggle('aktiv', +l.dataset.s === n); l.classList.toggle('fertig', +l.dataset.s < n); });
  window.scrollTo({ top: 0, behavior: 'smooth' });
  document.querySelector('nav li.aktiv')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}
function fehler(ziel, e) { $(ziel).innerHTML = `<div class="fehlerbox">${esc(e.message || e)}</div>`; }
async function sicher(btn, fn) {
  btn && (btn.disabled = true);
  try { await fn(); } catch (e) { console.error(e); alertInline(e); } finally { btn && (btn.disabled = false); }
}
function alertInline(e) {
  const sec = document.querySelector('section.schritt.aktiv');
  sec.querySelector('.fehlerbox.auto')?.remove();
  const b = el('div', { class: 'fehlerbox auto' }, 'Das hat nicht geklappt: ' + esc(e.message || e));
  sec.append(b);
}

// ---------- Monitor, Kacheln, Pegel ----------
function sichtbar(c) { return c.offsetParent !== null; }
function zeichneFake() {
  if (Z.fake && Z.roh) {
    const f = Z.roh;
    for (const c of document.querySelectorAll('canvas[data-program],canvas[data-scene],canvas[data-source]')) {
      if (!sichtbar(c)) continue;
      const ctx = c.getContext('2d');
      if (c.dataset.program) f.renderProgram(ctx, c.width, c.height);
      else if (c.dataset.scene) f.renderScene(ctx, c.dataset.scene, c.width, c.height);
      else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height); f.drawSource(ctx, c.dataset.source, 0, 0, c.width, c.height); }
    }
  }
  requestAnimationFrame(zeichneFake);
}
let rundeIdx = 0;
async function screenshotSchleife() {
  // echtes OBS: Programmbild öfter, Kacheln reihum (Befehle werden nicht protokolliert)
  while (true) {
    await sleep(250);
    if (Z.fake || !Z.roh) continue;
    try {
      const pgm = $('pgm');
      if (Z.program) await malScreenshot(pgm, Z.program);
      const kacheln = [...document.querySelectorAll('canvas[data-scene],canvas[data-source]')].filter(sichtbar);
      if (kacheln.length) { const c = kacheln[rundeIdx++ % kacheln.length]; await malScreenshot(c, c.dataset.scene || c.dataset.source); }
    } catch (e) { /* Quelle evtl. gerade gelöscht */ }
  }
}
async function malScreenshot(c, quelle) {
  const r = await Z.roh.call('GetSourceScreenshot', { sourceName: quelle, imageFormat: 'jpg', imageWidth: c.width, imageCompressionQuality: 70 });
  await new Promise((res) => { const img = new Image(); img.onload = () => { c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); res(); }; img.onerror = res; img.src = r.imageData; });
}
const pegelStand = new Map();
function pegelHandler({ inputs }) {
  for (const i of inputs) {
    const peak = i.inputLevelsMul.length ? Math.max(...i.inputLevelsMul.map((k) => k[1])) : 0;
    const db = peak > 0 ? 20 * Math.log10(peak) : -100;
    const alt = pegelStand.get(i.inputName) ?? -100;
    pegelStand.set(i.inputName, db > alt ? db : alt - 1.2); // Rücklauf wie ein Pegelmesser
  }
}
function zeichnePegel() {
  for (const m of document.querySelectorAll('.meter[data-input]')) {
    const db = pegelStand.get(m.dataset.input) ?? -100;
    m.querySelector('.fill').style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + '%';
    const t = m.parentElement.querySelector('.dbwert'); if (t) t.textContent = db < -59 ? '−∞' : db.toFixed(1).replace('-', '−') + ' dBFS';
  }
  requestAnimationFrame(zeichnePegel);
}
function meterHtml(name, gross = false) {
  return `<div class="meter ${gross ? 'gross' : ''}" data-input="${esc(name)}"><div class="zone" style="left:${(42 / 60) * 100}%;width:${(12 / 60) * 100}%"></div><div class="fill"></div></div>
  ${gross ? '' : '<!--'}<div class="skala"><span>−60</span><span>−48</span><span>−36</span><span>−24</span><span style="color:var(--green)">−18 … −6 Ziel</span><span>0 dBFS</span></div>${gross ? '' : '-->'}`;
}

// ---------- Uhr in der Kopfzeile ----------
setInterval(() => {
  if (Z.start && !Z.setupEnde) $('hZeit').textContent = fmtZeit(performance.now() - Z.start);
  if (Z.liveStart) $('liveZeit').textContent = fmtHms(performance.now() - Z.liveStart);
}, 250);

// ---------- 0 Verbinden ----------
for (const [k, q] of Object.entries(QUALITAET)) $('qualitaet').append(new Option(q.label, k));
$('qualitaet').onchange = () => { Z.qualitaet = $('qualitaet').value; $('hZiel').textContent = Z.qualitaet; };
const lokal = location.protocol === 'file:' || /^(localhost|127\.|\[::1\])/.test(location.hostname);
if (/claude|anthropic/.test(location.hostname)) {
  $('echtKarte').classList.add('aus');
  $('echtHinweis').textContent = 'Geht nicht in dieser Vorschau – öffne die Seite auf GitHub Pages oder die Datei lokal.';
} else if (!lokal) {
  $('echtHinweis').textContent = 'Am besten in Chrome, Edge oder Firefox. Fragt der Browser nach Zugriff aufs lokale Netzwerk, bitte erlauben.';
}

async function nachVerbinden(roh, fake) {
  Z.roh = roh; Z.fake = fake; Z.obs = mitProtokoll(roh); Z.start = performance.now();
  roh.on('InputVolumeMeters', pegelHandler);
  roh.on('CurrentProgramSceneChanged', ({ sceneName }) => setzeProgramm(sceneName));
  roh.on('ConnectionClosed', () => { $('modusBadge').textContent = 'Verbindung getrennt'; $('modusBadge').className = 'badge'; });
  $('modusBadge').textContent = fake ? 'Simulation' : 'Echtes OBS'; $('modusBadge').className = 'badge ' + (fake ? 'sim' : 'echt');
  $('pgmLeer').style.display = 'none';
  logGruppe('Verbinden & Qualitätsstandard');
  const v = await Z.obs.call('GetVersion');
  Z.os = v.platform === 'windows' ? 'windows' : v.platform === 'macos' ? 'macos' : 'linux'; // Linux meldet die Distribution, z. B. „ubuntu“
  $('obsVersion').textContent = `OBS ${v.obsVersion} · ${v.platform}`;
  await qualitaetSetzen(Z.obs, Z.qualitaet);
  const { currentProgramSceneName } = await Z.obs.call('GetSceneList');
  setzeProgramm(currentProgramSceneName);
  if (fake) { $('demoFehler').style.display = ''; $('demoKey').style.display = ''; }
  else { $('logoDemoZeile').style.display = 'none'; $('logoPfadZeile').style.display = ''; }
  await geraeteSuchen();
  zeige(1);
}
$('demoStart').onclick = () => sicher($('demoStart'), async () => { const f = new FakeOBS(); await f.connect(); await nachVerbinden(f, true); });
$('verbinden').onclick = () => sicher($('verbinden'), async () => {
  $('verbindenFehler').innerHTML = '';
  if (typeof OBSWebSocket === 'undefined') throw new Error('Die WebSocket-Bibliothek fehlt.');
  const o = new OBSWebSocket();
  try { await o.connect($('url').value.trim(), $('pw').value || undefined, { eventSubscriptions: OBSWebSocket.EventSubscription.All | OBSWebSocket.EventSubscription.InputVolumeMeters }); }
  catch (e) {
    const https = location.protocol === 'https:' ? ' Falls ja: Manche Browser (z. B. Safari) blocken von einer Webseite aus die Verbindung zum eigenen Rechner – dann Chrome/Edge/Firefox nehmen oder index.html herunterladen und lokal öffnen.' : '';
    throw new Error(`Keine Verbindung zu ${$('url').value}. Läuft OBS und ist der WebSocket-Server aktiviert? (${e.message || e.code || 'abgelehnt'})${https}`);
  }
  await nachVerbinden(o, false);
});

function setzeProgramm(n) {
  Z.program = n; $('pgmSzene').textContent = n || '–';
  document.querySelectorAll('.mv').forEach((b) => b.classList.toggle('pgm', b.dataset.szene === n));
}

// ---------- 1 Geräte ----------
async function geraeteSuchen() {
  logGruppe('Geräte suchen (UC1)');
  for (const art of ['kamera', 'mikro']) {
    if (art === 'kamera' && TEST.has('ohnekamerasuche')) continue; // nur für Testrechner ohne Videogeräte
    Z.gefunden[art] = await geraeteErkennen(Z.obs, Z.os, art).catch(() => ({ geraete: [] }));
  }
  geraeteFormular();
}
function optionenFuer(art) {
  const o = Z.gefunden[art].geraete.map((g) => ({ v: 'g:' + g.wert, t: g.name }));
  if (art === 'kamera') { o.push({ v: 'handy', t: 'Smartphone (über VDO.Ninja, kabellos)' }); if (!Z.fake) o.push({ v: 'testbild', t: 'Testbild (ohne Kamera)' }); }
  if (art === 'mikro' && TEST.get('testaudio')) o.push({ v: 'datei', t: 'Testton aus Datei' });
  return o;
}
function geraeteFormular() {
  const baue = (art, anzahl, liste, name, vorschlag) => {
    const opts = optionenFuer(art); const alt = [...liste.querySelectorAll('select')].map((s) => s.value);
    liste.innerHTML = '';
    if (!opts.length) liste.innerHTML = `<p class="hinweis">Kein Gerät gefunden.</p>`;
    for (let i = 0; i < anzahl; i++) {
      const row = el('div', { class: 'geraet' }, `<b>${name} ${i + 1}</b>`);
      const sel = el('select'); opts.forEach((o) => sel.append(new Option(o.t, o.v)));
      sel.value = alt[i] || vorschlag(opts, i);
      row.append(sel); liste.append(row);
    }
  };
  const kamVorschlag = (o, i) => {
    const echte = o.filter((x) => x.v.startsWith('g:') && !/virtual/i.test(x.t));
    if (Z.fake) return [echte[0], echte.find((x) => /Cam Link/.test(x.t)), { v: 'handy' }, echte[1]][i]?.v || o[0].v;
    return (echte[i] || o.find((x) => x.v === 'testbild') || o[0]).v;
  };
  const mikVorschlag = (o, i) => {
    const echte = o.filter((x) => !/^g:default$/.test(x.v));
    if (Z.fake) return [echte.find((x) => /NT-USB/.test(x.t)), echte.find((x) => /EW-D/.test(x.t)), echte[1]][i]?.v || o[0]?.v;
    return (o.find((x) => x.v === 'datei') || echte[i] || o[0])?.v;
  };
  baue('kamera', +$('anzK').value, $('kamListe'), 'Kamera', kamVorschlag);
  baue('mikro', +$('anzM').value, $('mikListe'), 'Mikrofon', mikVorschlag);
}
$('anzK').onchange = geraeteFormular; $('anzM').onchange = geraeteFormular;

$('quellenAnlegen').onclick = () => sicher($('quellenAnlegen'), async () => {
  logGruppe('Quellen anlegen (UC1)');
  $('quellenStatus').textContent = 'wird angelegt …';
  const kamSel = [...$('kamListe').querySelectorAll('select')].map((s) => s.value);
  const mikSel = [...$('mikListe').querySelectorAll('select')].map((s) => s.value);
  await szeneSicherstellen(Z.obs, HALTER);
  Z.kameras = []; Z.mikros = []; Z.handy = null;
  const farben = [0xff8a5a2b, 0xff2b5a8a, 0xff3c8a2b, 0xff6b2b8a];
  for (const [i, v] of kamSel.entries()) {
    const rolle = `Kamera ${i + 1}`;
    if (v === 'handy') { Z.handy ||= { ...vdoNinjaLinks(), rolle }; await quelleAnlegen(Z.obs, { rolle, typ: 'handy', url: Z.handy.view }); }
    else if (v === 'testbild') await quelleAnlegen(Z.obs, { rolle, typ: 'testbild', farbe: farben[i] });
    else await quelleAnlegen(Z.obs, { rolle, typ: 'geraet', kind: Z.gefunden.kamera.kind, prop: Z.gefunden.kamera.prop, wert: v.slice(2) });
    Z.kameras.push({ rolle, geraet: $('kamListe').querySelectorAll('select')[i].selectedOptions[0].text });
  }
  for (const [i, v] of mikSel.entries()) {
    const rolle = `Mikrofon ${i + 1}`;
    if (v === 'datei') await quelleAnlegen(Z.obs, { rolle, typ: 'datei', pfad: TEST.get('testaudio') });
    else await quelleAnlegen(Z.obs, { rolle, typ: 'geraet', kind: Z.gefunden.mikro.kind, prop: Z.gefunden.mikro.prop, wert: v.slice(2) });
    Z.mikros.push({ rolle, geraet: $('mikListe').querySelectorAll('select')[i].selectedOptions[0].text });
  }
  // Programm zeigt bis zur Bildaufteilung Kamera 1
  await szeneAusVorlage(Z.obs, 'Vollbild Kamera 1', null, { A: 'Kamera 1' }, Z.mikros.map((m) => m.rolle));
  await Z.obs.call('SetCurrentProgramScene', { sceneName: 'Vollbild Kamera 1' }); setzeProgramm('Vollbild Kamera 1');
  $('quellenStatus').textContent = `${Z.kameras.length} Kameras und ${Z.mikros.length} Mikrofone in OBS angelegt.`;
  $('quellenKacheln').innerHTML = '';
  for (const k of Z.kameras) {
    const d = el('div', { class: 'kachel' }, `<canvas width="320" height="180" data-source="${esc(k.rolle)}"></canvas><div class="unter"><span>${esc(k.rolle)}</span><span>${esc(k.geraet.split(' (')[0])}</span></div>`);
    $('quellenKacheln').append(d);
  }
  for (const m of Z.mikros) {
    const d = el('div', { class: 'kachel', style: 'background:var(--panel);padding:12px' }, `<div style="font-size:13px;margin-bottom:8px"><b>${esc(m.rolle)}</b> <span class="hinweis">${esc(m.geraet)}</span></div>${meterHtml(m.rolle)}`);
    $('quellenKacheln').append(d);
  }
  handyAnzeigen();
  tonFormular(); vorlagenFormular();
  $('weiter1').disabled = false; $('weiter1').className = '';
});
function handyAnzeigen() {
  const b = $('handyBox'); b.innerHTML = '';
  if (!Z.handy) return;
  b.innerHTML = `<div class="karte qr"><div class="code" id="qrCode"></div><div><b>${esc(Z.handy.rolle)}: Smartphone verbinden</b><p class="hinweis" style="margin:4px 0 8px">QR-Code mit der Handykamera scannen, Kamera erlauben – fertig. Keine App nötig. Das Bild kommt über VDO.Ninja direkt in OBS.</p><code>${esc(Z.handy.push)}</code></div></div>`;
  if (window.QRCode) new QRCode($('qrCode'), { text: Z.handy.push, width: 116, height: 116, correctLevel: QRCode.CorrectLevel.M });
  else $('qrCode').innerHTML = '<span class="hinweis" style="color:#333">QR-Code braucht Internet</span>';
}
$('weiter1').onclick = () => zeige(2);

// ---------- 2 Ton ----------
function tonFormular() {
  const l = $('tonListe'); l.innerHTML = '';
  for (const m of Z.mikros) {
    const k = el('div', { class: 'karte mik' });
    k.innerHTML = `<div class="kopf"><div><b>${esc(m.rolle)}</b> <small>${esc(m.geraet)}</small></div><button class="klein">Einmessen</button></div>
      ${meterHtml(m.rolle, true)}<div style="text-align:right;font:12px var(--mono);color:var(--muted);margin-top:4px" class="dbwert"></div>
      <div class="phase"></div><div class="ergebnis"></div>`;
    const btn = k.querySelector('button'), ph = k.querySelector('.phase'), erg = k.querySelector('.ergebnis');
    btn.onclick = () => sicher(btn, async () => {
      logGruppe(`Ton einmessen: ${m.rolle} (UC2)`);
      erg.innerHTML = '';
      let rest = 5; ph.textContent = `Sprich jetzt in normaler Lautstärke … ${rest}`;
      const iv = setInterval(() => { rest--; if (rest > 0) ph.textContent = `Sprich jetzt in normaler Lautstärke … ${rest}`; }, 1000);
      const r = await tonEinrichten(Z.obs, m.rolle, {
        onPhase: (p) => { if (p !== 'messen') clearInterval(iv); ph.textContent = { messen: ph.textContent, filter: 'Filterkette wird in OBS angelegt …', pruefen: 'Kontrollmessung – bitte weitersprechen …' }[p]; },
      });
      clearInterval(iv); ph.textContent = '';
      if (r.fehler) { erg.innerHTML = `<div class="fehlerbox">${esc(r.fehler)}</div>`; return; }
      Z.filter += r.kette.length; m.ton = r;
      const ok = r.nachher.p95Db >= -18 && r.nachher.p95Db <= -6;
      erg.innerHTML = `<div class="vergleich"><span class="hinweis">vorher</span><span class="gross" style="color:var(--muted)">${fmtDb(r.vorher.p95Db)}</span><span>→</span><span class="hinweis">nachher</span><span class="gross" style="color:${ok ? 'var(--green)' : 'var(--amber)'}">${fmtDb(r.nachher.p95Db)}</span><span class="hinweis">Ziel −12 dBFS</span></div>
        <div class="chips">${r.kette.map((f) => `<span class="chip">${esc(f.name)}<i>${esc(f.info)}</i></span>`).join('')}</div>`;
      btn.textContent = 'Neu einmessen';
    });
    l.append(k);
  }
}
const fmtDb = (v) => (v < -99 ? '−∞' : v.toFixed(1).replace('-', '−')) + ' dBFS';
$('weiter2').onclick = () => zeige(3);

// ---------- 3 Bild ----------
function vorlageSvg(name) {
  const f = VORLAGEN[name].felder; const W = 160, H = 90;
  return `<svg viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#000"/>${f.map((x, i) => `<rect x="${x.x * W + 1}" y="${x.y * H + 1}" width="${x.w * W - 2}" height="${x.h * H - 2}" rx="2" fill="${i ? '#5aa0ff' : '#3a4250'}" stroke="#0c0e11" stroke-width="${i ? 1.5 : 0}"/><text x="${(x.x + x.w / 2) * W}" y="${(x.y + x.h / 2) * H + 4}" font-size="11" font-family="IBM Plex Mono,monospace" fill="#fff" text-anchor="middle">${x.slot}</text>`).join('')}</svg>`;
}
function vorlagenFormular() {
  const v = $('vorlagen'); v.innerHTML = '';
  for (const name of Object.keys(VORLAGEN)) {
    const b = el('button', { class: 'vorlage' + (Z.vorlagen.has(name) ? ' an' : ''), type: 'button' }, `${vorlageSvg(name)}<span class="n">${esc(name)}<i>✓</i></span>`);
    b.onclick = () => { Z.vorlagen.has(name) ? Z.vorlagen.delete(name) : Z.vorlagen.add(name); b.classList.toggle('an'); };
    v.append(b);
  }
  for (const [id, i] of [['slotA', 0], ['slotB', 1]]) {
    const s = $(id); s.innerHTML = ''; Z.kameras.forEach((k) => s.append(new Option(`${k.rolle} – ${k.geraet.split(' (')[0]}`, k.rolle)));
    s.value = Z.kameras[Math.min(i, Z.kameras.length - 1)]?.rolle;
  }
}
$('szenenBauen').onclick = () => sicher($('szenenBauen'), async () => {
  logGruppe('Szenen aus Vorlagen anlegen (UC3)');
  const A = $('slotA').value, B = $('slotB').value;
  const plan = Z.kameras.map((k) => ({ name: 'Vollbild ' + k.rolle, vorlage: null, zu: { A: k.rolle } }));
  for (const v of Object.keys(VORLAGEN)) if (Z.vorlagen.has(v)) plan.push({ name: v, vorlage: v, zu: { A, B } });
  if (plan.length > 9) { plan.length = 9; $('szenenStatus').textContent = 'Maximal 9 Tasten – überzählige Vorlagen weggelassen.'; }
  // alte Szenen des Assistenten entfernen, die nicht mehr gebraucht werden
  for (const alt of Z.szenen) if (!plan.some((p) => p.name === alt) && alt !== Z.program) await Z.obs.call('RemoveScene', { sceneName: alt }).catch(() => {});
  for (const p of plan) { $('szenenStatus').textContent = `lege „${p.name}“ an …`; await szeneAusVorlage(Z.obs, p.name, p.vorlage, p.zu, Z.mikros.map((m) => m.rolle)); }
  Z.szenen = plan.map((p) => p.name); Z.grafik = null;
  await Z.obs.call('SetCurrentProgramScene', { sceneName: Z.szenen[0] }); setzeProgramm(Z.szenen[0]);
  $('szenenStatus').textContent = `${Z.szenen.length} Szenen angelegt – jede ist eine Taste beim Live-Schalten.`;
  $('szenenKacheln').innerHTML = '';
  Z.szenen.forEach((s, i) => $('szenenKacheln').append(el('div', { class: 'kachel' }, `<canvas width="320" height="180" data-scene="${esc(s)}"></canvas><div class="unter"><span>Taste ${i + 1}</span><span>${esc(s)}</span></div>`)));
  $('weiter3').disabled = false; $('weiter3').className = '';
  $('kollision').innerHTML = ''; $('weiter4').style.display = 'none';
});
$('weiter3').onclick = () => zeige(4);

// ---------- 4 Grafik ----------
let logoDaten = null; // { pfad, dataUrl }
function beispielLogo() {
  const c = document.createElement('canvas'); c.width = 420; c.height = 150; const x = c.getContext('2d');
  x.fillStyle = 'rgba(12,14,17,.88)'; x.beginPath(); x.roundRect(4, 4, 412, 142, 22); x.fill();
  x.fillStyle = '#ff3b30'; x.beginPath(); x.arc(74, 75, 26, 0, 7); x.fill();
  x.fillStyle = '#fff'; x.font = '700 46px "IBM Plex Sans", sans-serif'; x.fillText('CAMPUS', 120, 72);
  x.font = '600 30px "IBM Plex Mono", monospace'; x.fillStyle = '#9aa2ad'; x.fillText('LIVE · TV', 122, 112);
  return c.toDataURL('image/png');
}
$('logoDatei').onchange = () => {
  const f = $('logoDatei').files[0]; if (!f) return;
  const r = new FileReader(); r.onload = () => { logoDaten = { pfad: 'C:\\Users\\Studio\\Bilder\\' + f.name, dataUrl: r.result }; $('logoName').textContent = f.name; }; r.readAsDataURL(f);
};
async function logoRegistrieren() {
  if (!Z.fake) { const p = $('logoPfad').value.trim(); if (!p) throw new Error('Bitte den Pfad zur Bilddatei eintragen.'); return p; }
  if (!logoDaten) logoDaten = { pfad: 'C:\\Users\\Studio\\Bilder\\campus-live-logo.png', dataUrl: beispielLogo() };
  const img = new Image(); img.src = logoDaten.dataUrl; await img.decode().catch(() => {});
  Z.roh.images.set(logoDaten.pfad, img); return logoDaten.pfad;
}
$('logoEinfuegen').onclick = () => sicher($('logoEinfuegen'), async () => {
  logGruppe('Grafik einfügen & Kollision prüfen (UC4)');
  const datei = await logoRegistrieren(); const ecke = $('logoEcke').value;
  await grafikEinfuegen(Z.obs, Z.szenen, { datei, ecke }); Z.grafik = 'Grafik (Logo)';
  await kollisionZeigen(ecke);
});
async function kollisionZeigen(ecke) {
  const { c, treffer } = await kollisionPruefen(Z.obs, Z.szenen, Z.grafik);
  const k = $('kollision');
  if (!treffer.length) {
    k.innerHTML = `<div class="okbox">✓ Geprüft in ${Z.szenen.length} Szenen: Das Logo ${ECKEN[ecke]} verdeckt kein Kamerabild.</div>`;
    $('weiter4').style.display = ''; $('weiter4').className = ''; return;
  }
  const frei = await freieEcke(Z.obs, Z.szenen, null);
  const t = treffer.sort((a, b) => b.anteil - a.anteil)[0];
  const pct = (v, g) => (v / g * 100).toFixed(2) + '%';
  const ix = Math.max(t.grafik.x, t.bild.x), iy = Math.max(t.grafik.y, t.bild.y);
  const iw = Math.min(t.grafik.x + t.grafik.w, t.bild.x + t.bild.w) - ix, ih = Math.min(t.grafik.y + t.grafik.h, t.bild.y + t.bild.h) - iy;
  k.innerHTML = `<div class="warnbox"><b>Achtung: Das Logo verdeckt ein Kamerabild.</b><br>
    ${treffer.map((x) => `In „${esc(x.szene)}“ liegt es über <b>${x.anteil} %</b> von ${esc(x.quelle)}.`).join('<br>')}
    <div class="kollbild"><canvas width="420" height="236" data-scene="${esc(t.szene)}"></canvas>
      <div class="box" style="left:${pct(t.bild.x, c.w)};top:${pct(t.bild.y, c.h)};width:${pct(t.bild.w, c.w)};height:${pct(t.bild.h, c.h)}"></div>
      <div class="box x" style="left:${pct(ix, c.w)};top:${pct(iy, c.h)};width:${pct(iw, c.w)};height:${pct(ih, c.h)}"></div></div>
    <div class="zeile" style="margin-bottom:0">${frei ? `<button class="gruen" id="verschieben">In freie Ecke verschieben (${ECKEN[frei]})</button>` : '<span>Keine Ecke ist in allen Szenen frei.</span>'}<button class="zweit" id="lassen">So lassen</button></div></div>`;
  if (frei) $('verschieben').onclick = () => sicher($('verschieben'), async () => {
    logGruppe(`Grafik verschieben nach ${ECKEN[frei]} & nachprüfen`);
    await grafikVerschieben(Z.obs, Z.szenen, Z.grafik, frei); $('logoEcke').value = frei; await kollisionZeigen(frei);
  });
  $('lassen').onclick = () => { $('weiter4').style.display = ''; $('weiter4').className = ''; };
}
$('grafikSkip').onclick = () => zeige(5);
$('weiter4').onclick = () => zeige(5);

// ---------- 5 Startcheck ----------
$('plattform').onchange = () => { $('server').value = $('plattform').value; };
$('demoKey').onclick = () => { $('key').value = 'demo-' + Math.random().toString(36).slice(2, 6) + '-' + Math.random().toString(36).slice(2, 6); };
$('nurAufnahme').onchange = () => { const a = $('nurAufnahme').checked; ['plattform', 'server', 'key'].forEach((i) => ($(i).disabled = a)); };
$('pruefen').onclick = () => sicher($('pruefen'), pruefen);
async function pruefen() {
  logGruppe('Startcheck (UC5)');
  $('pruefStatus').textContent = 'prüfe Bild, Ton und Ziel …'; $('liveGehen').disabled = true;
  const nurAufnahme = $('nurAufnahme').checked;
  if (!nurAufnahme && $('key').value.trim()) await Z.obs.call('SetStreamServiceSettings', { streamServiceType: 'rtmp_custom', streamServiceSettings: { server: $('server').value.trim(), key: $('key').value.trim() } });
  const erg = await startcheck(Z.obs, { kameras: Z.kameras.map((k) => k.rolle), mikros: Z.mikros.map((m) => m.rolle), ziel: QUALITAET[Z.qualitaet], grafik: Z.grafik, szenen: Z.szenen, nurAufnahme });
  const a = $('ampel'); a.innerHTML = '';
  for (const p of erg) {
    const z = el('div', { class: 'p ' + p.status }, `<i class="dot"></i><b>${esc(p.punkt)}</b><span>${esc(p.info)}${p.soll ? ` (Ziel ${esc(p.soll)})` : ''}</span>`);
    let fix = null;
    if (p.fix === 'unmute') fix = ['Stumm aufheben', () => Z.obs.call('SetInputMute', { inputName: p.punkt, inputMuted: false })];
    else if (p.art === 'kamera' && p.status === 'rot' && Z.demoBackup[p.punkt]) fix = ['Neu verbinden', async () => { await Z.obs.call('SetInputSettings', { inputName: p.punkt, inputSettings: Z.demoBackup[p.punkt] }); delete Z.demoBackup[p.punkt]; }];
    else if (p.art === 'mikro' && /nicht eingemessen/.test(p.info)) fix = ['Einmessen', async () => zeige(2)];
    else if (p.punkt === 'Stream-Ziel' && p.status === 'rot') fix = ['Key eintragen', async () => $('key').focus()];
    if (fix) { const b = el('button', { class: 'zweit klein' }, fix[0]); b.onclick = () => sicher(b, async () => { await fix[1](); if (Z.schritt === 5 && fix[0] !== 'Key eintragen') await pruefen(); }); z.append(b); } else z.append(el('span'));
    a.append(z);
  }
  const rot = erg.filter((p) => p.status === 'rot').length, gelb = erg.filter((p) => p.status === 'gelb').length;
  $('liveGehen').disabled = rot > 0;
  $('liveGehen').textContent = nurAufnahme ? 'Aufnahme starten' : 'Live gehen';
  $('pruefStatus').textContent = '';
  $('liveHinweis').textContent = rot ? `${rot} Punkt(e) rot – erst beheben, dann geht es los.` : gelb ? `Startklar. ${gelb} Hinweis(e) in Gelb kannst du bewusst in Kauf nehmen.` : 'Alles grün – du bist startklar.';
}
$('fMute').onclick = () => sicher($('fMute'), async () => { logGruppe('Vorführung: Fehler auslösen'); await Z.obs.call('SetInputMute', { inputName: 'Mikrofon 1', inputMuted: true }); await pruefen(); });
$('fKamera').onclick = () => sicher($('fKamera'), async () => {
  logGruppe('Vorführung: Kamera abziehen');
  const k = Z.kameras.find((x) => Z.roh.s.inputs.get(x.rolle)?.kind === 'dshow_input') || Z.kameras[0];
  const { inputSettings } = await Z.obs.call('GetInputSettings', { inputName: k.rolle });
  Z.demoBackup[k.rolle] = { video_device_id: inputSettings.video_device_id };
  await Z.obs.call('SetInputSettings', { inputName: k.rolle, inputSettings: { video_device_id: '' } }); await pruefen();
});
$('liveGehen').onclick = () => sicher($('liveGehen'), async () => {
  logGruppe('Sendung starten');
  const nurAufnahme = $('nurAufnahme').checked;
  await uebergangWaehlen(Z.obs, 'cut');
  await Z.obs.call(nurAufnahme ? 'StartRecord' : 'StartStream');
  Z.setupEnde = performance.now(); Z.liveStart = performance.now(); Z.schnitte = 0;
  $('hZeit').textContent = fmtZeit(Z.setupEnde - Z.start);
  $('brand').classList.add('live'); $('monitor').classList.add('live'); $('pgmLbl').classList.add('live'); $('pgmLbl').textContent = nurAufnahme ? '● REC' : 'ON AIR';
  document.querySelector('.onair .lamp').textContent = nurAufnahme ? '● REC' : 'ON AIR';
  $('liveZiel').textContent = nurAufnahme ? 'Aufnahme läuft' : `→ ${$('plattform').selectedOptions[0].text}`;
  liveAufbauen(); zeige(6);
});

// ---------- 6 Live ----------
function liveAufbauen() {
  const mv = $('multiview'); mv.innerHTML = '';
  Z.szenen.forEach((s, i) => {
    const b = el('button', { class: 'mv' + (s === Z.program ? ' pgm' : ''), 'data-szene': s, type: 'button' }, `<canvas width="320" height="180" data-scene="${esc(s)}"></canvas><div class="unter"><span class="taste">${i + 1}</span><span>${esc(s)}</span></div>`);
    b.onclick = () => schalteAuf(s);
    mv.append(b);
  });
  $('livePegel').innerHTML = Z.mikros.map((m) => `<div class="karte" style="padding:12px"><div style="font-size:13px;margin-bottom:6px;display:flex;justify-content:space-between"><b>${esc(m.rolle)}</b><span class="dbwert hinweis" style="font-family:var(--mono)"></span></div>${meterHtml(m.rolle)}</div>`).join('');
}
async function schalteAuf(s) {
  if (s === Z.program) return;
  setzeProgramm(s); Z.schnitte++; $('schnitte').textContent = Z.schnitte;
  try { await schalten(Z.obs, s); } catch (e) { alertInline(e); }
}
document.addEventListener('keydown', (e) => {
  if (Z.schritt !== 6 || e.target.matches('input,select')) return;
  const n = +e.key; if (n >= 1 && n <= Z.szenen.length) schalteAuf(Z.szenen[n - 1]);
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); const i = Z.szenen.indexOf(Z.program); schalteAuf(Z.szenen[(i + 1) % Z.szenen.length]); }
});
$('uebergang').onclick = (e) => {
  const u = e.target.dataset.u; if (!u) return;
  [...$('uebergang').children].forEach((b) => b.classList.toggle('an', b === e.target));
  uebergangWaehlen(Z.obs, u).catch(alertInline);
};
$('beenden').onclick = () => sicher($('beenden'), async () => {
  logGruppe('Sendung beenden');
  const nurAufnahme = $('nurAufnahme').checked;
  await Z.obs.call(nurAufnahme ? 'StopRecord' : 'StopStream');
  const dauer = performance.now() - Z.liveStart; Z.liveStart = 0;
  $('brand').classList.remove('live'); $('monitor').classList.remove('live'); $('pgmLbl').classList.remove('live'); $('pgmLbl').textContent = 'PROGRAMM';
  const zahlen = [
    [fmtZeit(Z.setupEnde - Z.start), 'Minuten von „Verbinden“ bis live'],
    [Z.befehle, 'Befehle an OBS geschickt'],
    ['0', 'Klicks direkt in OBS'],
    [Z.szenen.length, 'Szenen automatisch angelegt'],
    [Z.kameras.length + Z.mikros.length, 'Quellen eingerichtet'],
    [Z.filter, 'Audiofilter gesetzt'],
    [fmtHms(dauer), 'Sendedauer'],
    [Z.schnitte, 'Schnitte per Taste'],
  ];
  $('zahlen').innerHTML = zahlen.map(([w, t]) => `<div class="zahl"><b>${esc(w)}</b><span>${esc(t)}</span></div>`).join('');
  zeige(7);
});
$('nochmal').onclick = () => location.reload();

// Klick auf erledigte Schritte springt zurück
document.querySelectorAll('#schritte li').forEach((li) => li.onclick = () => { const n = +li.dataset.s; if (n < Z.schritt && Z.schritt < 6 && n > 0) zeige(n); });

requestAnimationFrame(zeichneFake); requestAnimationFrame(zeichnePegel); screenshotSchleife();
