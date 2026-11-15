// =====================================================================
// Kern des Sende-Assistenten: die gesamte OBS-Logik.
// Jede Funktion bekommt ein Objekt mit .call(requestType, data), also
// entweder obs-websocket-js (echtes OBS) oder die Simulation.
// =====================================================================
const HALTER = 'Quellen (Assistent)';

const QUALITAET = {
  '1080p60': { w: 1920, h: 1080, fps: 60, label: '1080p · 60 fps (Standard)' },
  '1080p30': { w: 1920, h: 1080, fps: 30, label: '1080p · 30 fps (schwächerer Laptop)' },
  '720p30': { w: 1280, h: 720, fps: 30, label: '720p · 30 fps (langsames Netz)' },
};

async function qualitaetSetzen(obs, key) {
  const q = QUALITAET[key];
  await obs.call('SetVideoSettings', { baseWidth: q.w, baseHeight: q.h, outputWidth: q.w, outputHeight: q.h, fpsNumerator: q.fps, fpsDenominator: 1 });
  return q;
}
async function leinwand(obs) {
  const v = await obs.call('GetVideoSettings');
  return { w: v.baseWidth, h: v.baseHeight, outW: v.outputWidth, outH: v.outputHeight, fps: +(v.fpsNumerator / v.fpsDenominator).toFixed(2) };
}

// ---------- Geräteerkennung je Betriebssystem ----------
const GERAETE_ARTEN = {
  windows: { kamera: [['dshow_input', 'video_device_id']], mikro: [['wasapi_input_capture', 'device_id']] },
  macos: { kamera: [['macos-avcapture', 'device'], ['av_capture_input_v2', 'device'], ['av_capture_input', 'device']], mikro: [['coreaudio_input_capture', 'device_id']] },
  linux: { kamera: [['v4l2_input', 'device_id']], mikro: [['pulse_input_capture', 'device_id'], ['alsa_input_capture', 'device_id']] },
};

async function szeneSicherstellen(obs, name) {
  const { scenes } = await obs.call('GetSceneList');
  if (scenes.some((s) => s.sceneName === name)) {
    const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: name });
    for (const it of sceneItems) await obs.call('RemoveSceneItem', { sceneName: name, sceneItemId: it.sceneItemId });
  } else {
    await obs.call('CreateScene', { sceneName: name });
  }
}
async function quelleEntfernenFallsDa(obs, name) {
  const { inputs } = await obs.call('GetInputList');
  if (!inputs.some((i) => i.inputName === name)) return;
  // OBS zerstört Quellen verzögert und hält den Namen so lange belegt.
  // Darum erst umbenennen (gibt den Namen sofort frei), dann entfernen.
  const weg = `${name} (alt ${Date.now().toString(36)})`;
  await obs.call('SetInputName', { inputName: name, newInputName: weg });
  await obs.call('RemoveInput', { inputName: weg });
}

async function geraeteErkennen(obs, os, art) {
  const { inputKinds } = await obs.call('GetInputKindList', { unversioned: false });
  const kandidaten = (GERAETE_ARTEN[os] || GERAETE_ARTEN.windows)[art].filter(([k]) => inputKinds.includes(k));
  if (!kandidaten.length) return { kind: null, prop: null, geraete: [] };
  const [kind, prop] = kandidaten[0];
  const probe = '__assistent_suche';
  await quelleEntfernenFallsDa(obs, probe);
  await szeneSicherstellen(obs, HALTER);
  await obs.call('CreateInput', { sceneName: HALTER, inputName: probe, inputKind: kind, inputSettings: {}, sceneItemEnabled: false });
  try {
    const { propertyItems } = await obs.call('GetInputPropertiesListPropertyItems', { inputName: probe, propertyName: prop });
    return { kind, prop, geraete: propertyItems.filter((p) => p.itemEnabled !== false && p.itemValue !== '').map((p) => ({ name: p.itemName, wert: p.itemValue })) };
  } finally {
    await obs.call('RemoveInput', { inputName: probe });
  }
}

// q = { rolle:'Kamera 1', typ:'geraet'|'handy'|'testbild'|'datei', kind, prop, wert, url, pfad }
async function quelleAnlegen(obs, q) {
  await quelleEntfernenFallsDa(obs, q.rolle);
  let inputKind, inputSettings;
  if (q.typ === 'geraet') { inputKind = q.kind; inputSettings = { [q.prop]: q.wert }; }
  else if (q.typ === 'handy') { inputKind = 'browser_source'; inputSettings = { url: q.url, width: 1920, height: 1080, reroute_audio: false }; }
  else if (q.typ === 'testbild') { inputKind = 'color_source_v3'; inputSettings = { color: q.farbe ?? 0xff8a5a2b, width: 1920, height: 1080 }; }
  else if (q.typ === 'datei') { inputKind = 'ffmpeg_source'; inputSettings = { local_file: q.pfad, looping: true, is_local_file: true, restart_on_activate: false, close_when_inactive: false }; }
  await obs.call('CreateInput', { sceneName: HALTER, inputName: q.rolle, inputKind, inputSettings });
}

// VDO.Ninja: Handy öffnet den Push-Link, OBS zeigt den View-Link als Browserquelle
function vdoNinjaLinks() {
  const id = 'sa' + Math.random().toString(36).slice(2, 9);
  return { id, push: `https://vdo.ninja/?push=${id}&quality=2&webcam`, view: `https://vdo.ninja/?view=${id}&scene&cleanoutput` };
}

// ---------- Ton: Auto-Pegel + Sprachkette ----------
function pegelMessen(obs, inputName, dauerMs, onWert) {
  return new Promise((resolve) => {
    const spitzen = [];
    const h = ({ inputs }) => {
      const i = inputs.find((x) => x.inputName === inputName);
      if (!i) return;
      const peak = i.inputLevelsMul.length ? Math.max(...i.inputLevelsMul.map((k) => k[1])) : 0;
      spitzen.push(peak); onWert?.(peak);
    };
    obs.on('InputVolumeMeters', h);
    setTimeout(() => {
      obs.off('InputVolumeMeters', h);
      const db = (v) => (v > 0 ? 20 * Math.log10(v) : -100);
      const st = [...spitzen].sort((a, b) => a - b);
      resolve({ messwerte: st.length, spitzeDb: +db(st.at(-1) ?? 0).toFixed(1), p95Db: +db(st[Math.floor(st.length * 0.95)] ?? 0).toFixed(1) });
    }, dauerMs);
  });
}

// Kompressor setzt 6 dB unter den gemessenen Spitzen an (Ratio 3:1 → Spitzen −4 dB),
// danach hebt die Verstärkung auf den Zielpegel, der Limiter fängt Ausreißer bei −3 dBFS.
function spracheKette(p95Db, zielDb) {
  const thr = Math.round(p95Db - 6), ratio = 3;
  const nachKomp = thr + (p95Db - thr) / ratio;
  const gain = Math.max(-20, Math.min(30, +(zielDb - nachKomp).toFixed(1)));
  return [
    ['Rauschunterdrückung', 'noise_suppress_filter_v2', { method: 'speex', suppress_level: -30 }, 'Rauschen −30 dB'],
    ['Kompressor', 'compressor_filter', { ratio, threshold: thr, attack_time: 6, release_time: 60, output_gain: 0 }, `3:1 ab ${String(thr).replace('-', '−')} dB`],
    ['Verstärkung (auto)', 'gain_filter', { db: gain }, `${gain > 0 ? '+' : ''}${gain} dB`],
    ['Limiter', 'limiter_filter', { threshold: -3, release_time: 60 }, 'max. −3 dBFS'],
  ];
}
async function filterEntfernen(obs, inputName) {
  const { filters } = await obs.call('GetSourceFilterList', { sourceName: inputName });
  for (const f of filters) await obs.call('RemoveSourceFilter', { sourceName: inputName, filterName: f.filterName });
}
async function tonEinrichten(obs, inputName, { zielDb = -12, messMs = 5000, nachMs = 2500, onPhase, onWert } = {}) {
  await filterEntfernen(obs, inputName);
  onPhase?.('messen');
  const vorher = await pegelMessen(obs, inputName, messMs, onWert);
  if (vorher.p95Db < -70) return { vorher, fehler: 'Kein Signal – ist das Mikro eingesteckt und nicht stumm?' };
  const kette = spracheKette(vorher.p95Db, zielDb);
  onPhase?.('filter');
  for (const [filterName, filterKind, filterSettings] of kette) await obs.call('CreateSourceFilter', { sourceName: inputName, filterName, filterKind, filterSettings });
  onPhase?.('pruefen');
  const nachher = await pegelMessen(obs, inputName, nachMs, onWert);
  return { vorher, nachher, kette: kette.map(([n, , , info]) => ({ name: n, info })) };
}

// ---------- Bildvorlagen ----------
// Maße relativ zur Leinwand (0..1). crop: Überstand beschneiden statt Ränder lassen.
const VORLAGEN = {
  'Bild im Bild unten rechts': { kurz: 'BiB ↘', felder: [{ slot: 'A', x: 0, y: 0, w: 1, h: 1 }, { slot: 'B', x: 0.70, y: 0.66, w: 0.27, h: 0.27 }] },
  'Bild im Bild unten links': { kurz: 'BiB ↙', felder: [{ slot: 'A', x: 0, y: 0, w: 1, h: 1 }, { slot: 'B', x: 0.03, y: 0.66, w: 0.27, h: 0.27 }] },
  'Bild im Bild oben rechts': { kurz: 'BiB ↗', felder: [{ slot: 'A', x: 0, y: 0, w: 1, h: 1 }, { slot: 'B', x: 0.70, y: 0.07, w: 0.27, h: 0.27 }] },
  'Halb / Halb': { kurz: '½ | ½', felder: [{ slot: 'A', x: 0, y: 0.25, w: 0.5, h: 0.5 }, { slot: 'B', x: 0.5, y: 0.25, w: 0.5, h: 0.5 }] },
  'Zwei Drittel / Drittel': { kurz: '⅔ | ⅓', felder: [{ slot: 'A', x: 0, y: 0, w: 0.667, h: 1, crop: true }, { slot: 'B', x: 0.667, y: 0, w: 0.333, h: 1, crop: true }] },
  'Nebeneinander, beschnitten': { kurz: '▮▮', felder: [{ slot: 'A', x: 0, y: 0, w: 0.5, h: 1, crop: true }, { slot: 'B', x: 0.5, y: 0, w: 0.5, h: 1, crop: true }] },
};

async function feldSetzen(obs, szene, sceneItemId, feld, c) {
  const bw = Math.round(feld.w * c.w), bh = Math.round(feld.h * c.h);
  const tr = { alignment: 5, positionX: Math.round(feld.x * c.w), positionY: Math.round(feld.y * c.h), boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0, boundsWidth: bw, boundsHeight: bh, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 };
  if (feld.crop) {
    const { sceneItemTransform: t } = await obs.call('GetSceneItemTransform', { sceneName: szene, sceneItemId });
    const sw = t.sourceWidth || c.w, sh = t.sourceHeight || c.h;
    const ziel = bw / bh, quelle = sw / sh;
    if (quelle > ziel) { const weg = Math.round((sw - sh * ziel) / 2); tr.cropLeft = weg; tr.cropRight = weg; }
    else { const weg = Math.round((sh - sw / ziel) / 2); tr.cropTop = weg; tr.cropBottom = weg; }
  }
  await obs.call('SetSceneItemTransform', { sceneName: szene, sceneItemId, sceneItemTransform: tr });
}

// mikros: Tonquellen müssen in jeder Sendeszene liegen, sonst sind sie in OBS
// inaktiv – nicht im Stream und ohne Pegelanzeige.
async function szeneAusVorlage(obs, szene, vorlage, zuordnung, mikros = []) {
  const c = await leinwand(obs);
  await szeneSicherstellen(obs, szene);
  const felder = vorlage ? VORLAGEN[vorlage].felder : [{ slot: 'A', x: 0, y: 0, w: 1, h: 1 }];
  for (const feld of felder) {
    const { sceneItemId } = await obs.call('CreateSceneItem', { sceneName: szene, sourceName: zuordnung[feld.slot] });
    await feldSetzen(obs, szene, sceneItemId, feld, c);
  }
  for (const m of mikros) await obs.call('CreateSceneItem', { sceneName: szene, sourceName: m });
}

// ---------- Grafik + Kollisionsprüfung ----------
const ECKEN = { ol: 'oben links', or: 'oben rechts', ul: 'unten links', ur: 'unten rechts' };
function eckRect(ecke, c, gw = 0.22, gh = 0.14, rand = 0.03) {
  const w = gw * c.w, h = gh * c.h, mx = rand * c.w, my = rand * c.h * 1.5;
  return { x: ecke[1] === 'l' ? mx : c.w - mx - w, y: ecke[0] === 'o' ? my : c.h - my - h, w, h };
}
function schnitt(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
function sichtbaresRect(t) {
  // Bounds-Box (wir setzen immer SCALE_INNER); reicht für die Prüfung
  return { x: t.positionX, y: t.positionY, w: t.boundsWidth || t.width, h: t.boundsHeight || t.height };
}
// Prüft in allen Szenen, ob eine Grafik über einem kleinen Kamerabild liegt.
async function kollisionPruefen(obs, szenen, grafikName) {
  const c = await leinwand(obs);
  const treffer = [];
  for (const szene of szenen) {
    const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: szene });
    const g = sceneItems.find((i) => i.sourceName === grafikName);
    if (!g || !g.sceneItemEnabled) continue;
    const gr = sichtbaresRect(g.sceneItemTransform);
    for (const it of sceneItems) {
      if (it.sourceName === grafikName) continue;
      const r = sichtbaresRect(it.sceneItemTransform);
      if (!r.w || !r.h) continue; // Tonquelle, kein Bild
      if (r.w * r.h > 0.5 * c.w * c.h) continue; // Vollbild: Grafik liegt dort gewollt darüber
      const anteil = schnitt(gr, r) / (r.w * r.h);
      if (anteil > 0.01) treffer.push({ szene, quelle: it.sourceName, anteil: Math.round(anteil * 100), grafik: gr, bild: r });
    }
  }
  return { c, treffer };
}
// Ecke finden, in der die Grafik in keiner Szene ein kleines Bild verdeckt
async function freieEcke(obs, szenen, bevorzugt) {
  const c = await leinwand(obs);
  const kleine = [];
  for (const szene of szenen) {
    const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: szene });
    for (const it of sceneItems) { const r = sichtbaresRect(it.sceneItemTransform); if (r.w && r.h && r.w * r.h <= 0.5 * c.w * c.h && !/^Grafik/.test(it.sourceName)) kleine.push(r); }
  }
  const reihenfolge = [bevorzugt, 'ol', 'or', 'ul', 'ur'].filter((v, i, a) => v && a.indexOf(v) === i);
  return reihenfolge.find((e) => kleine.every((r) => schnitt(eckRect(e, c), r) === 0)) || null;
}
async function grafikEinfuegen(obs, szenen, { name = 'Grafik (Logo)', datei, ecke }) {
  await quelleEntfernenFallsDa(obs, name);
  await obs.call('CreateInput', { sceneName: HALTER, inputName: name, inputKind: 'image_source', inputSettings: { file: datei } });
  for (const s of szenen) await obs.call('CreateSceneItem', { sceneName: s, sourceName: name });
  await grafikVerschieben(obs, szenen, name, ecke);
}
async function grafikVerschieben(obs, szenen, name, ecke) {
  const c = await leinwand(obs); const r = eckRect(ecke, c);
  for (const s of szenen) {
    const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: s });
    const it = sceneItems.find((i) => i.sourceName === name); if (!it) continue;
    await obs.call('SetSceneItemTransform', { sceneName: s, sceneItemId: it.sceneItemId, sceneItemTransform: { alignment: 5, positionX: Math.round(r.x), positionY: Math.round(r.y), boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0, boundsWidth: Math.round(r.w), boundsHeight: Math.round(r.h) } });
  }
}

// ---------- Startcheck ----------
function bildHelligkeit(dataUrl) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = 32; c.height = 18; const x = c.getContext('2d');
      x.drawImage(img, 0, 0, 32, 18); const d = x.getImageData(0, 0, 32, 18).data;
      let sum = 0; for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
      res(sum / (d.length / 4));
    };
    img.onerror = () => res(0); img.src = dataUrl;
  });
}
async function startcheck(obs, { kameras, mikros, ziel, grafik, szenen, nurAufnahme }) {
  const e = [];
  const c = await leinwand(obs);
  e.push({ punkt: 'Auflösung', status: c.outW >= ziel.w && c.outH >= ziel.h ? 'gruen' : 'gelb', info: `${c.outW}×${c.outH}`, soll: `${ziel.w}×${ziel.h}` });
  e.push({ punkt: 'Bildrate', status: c.fps >= ziel.fps ? 'gruen' : 'gelb', info: `${c.fps} fps`, soll: `${ziel.fps} fps` });
  for (const k of kameras) {
    const s = await obs.call('GetSourceScreenshot', { sourceName: k, imageFormat: 'jpg', imageWidth: 64 }).catch(() => null);
    const hell = s ? await bildHelligkeit(s.imageData) : 0;
    e.push({ punkt: k, art: 'kamera', status: hell > 8 ? 'gruen' : 'rot', info: hell > 8 ? 'Bild kommt an' : 'kein Bild (schwarz)' });
  }
  for (const m of mikros) {
    const { inputMuted } = await obs.call('GetInputMute', { inputName: m });
    const p = inputMuted ? null : await pegelMessen(obs, m, 1500);
    const { filters } = await obs.call('GetSourceFilterList', { sourceName: m });
    let st = 'gruen', info = `Spitze ${p?.spitzeDb} dBFS · ${filters.length} Filter`;
    if (inputMuted) { st = 'rot'; info = 'stumm geschaltet'; }
    else if (p.spitzeDb < -50) { st = 'rot'; info = 'kein Signal'; }
    else if (p.spitzeDb > -1) { st = 'gelb'; info = `Übersteuert (${p.spitzeDb} dBFS)`; }
    else if (!filters.length) { st = 'gelb'; info += ' – Ton nicht eingemessen'; }
    e.push({ punkt: m, art: 'mikro', status: st, info, fix: inputMuted ? 'unmute' : null });
  }
  if (grafik) {
    const k = await kollisionPruefen(obs, szenen, grafik);
    e.push({ punkt: 'Grafik', status: k.treffer.length ? 'gelb' : 'gruen', info: k.treffer.length ? `verdeckt Bild in ${k.treffer.length} Szene(n)` : 'verdeckt nichts' });
  }
  if (nurAufnahme) e.push({ punkt: 'Ziel', status: 'gruen', info: 'Aufnahme auf diesem Rechner' });
  else {
    const svc = await obs.call('GetStreamServiceSettings');
    const key = svc.streamServiceSettings?.key;
    e.push({ punkt: 'Stream-Ziel', status: key ? 'gruen' : 'rot', info: key ? (svc.streamServiceSettings.server || svc.streamServiceSettings.service) : 'kein Stream-Key' });
  }
  return e;
}

// ---------- Live: Bildmischer-Ersatz ----------
async function uebergangWaehlen(obs, art) {
  const { transitions } = await obs.call('GetSceneTransitionList');
  const t = transitions.find((x) => x.transitionKind === (art === 'auto' ? 'fade_transition' : 'cut_transition'));
  if (t) await obs.call('SetCurrentSceneTransition', { transitionName: t.transitionName });
  if (art === 'auto') await obs.call('SetCurrentSceneTransitionDuration', { transitionDuration: 300 }).catch(() => {});
}
async function schalten(obs, szene) { await obs.call('SetCurrentProgramScene', { sceneName: szene }); }
