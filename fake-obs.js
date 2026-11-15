// =====================================================================
// Simuliertes OBS Studio für die Demo.
// Versteht dieselben obs-websocket-v5-Befehle, die der Assistent auch an
// ein echtes OBS schickt, hält einen Zustand (Szenen, Quellen, Filter,
// Stream) und zeichnet Programmbild und Quellen selbst.
// =====================================================================
class FakeOBS {
  constructor() {
    this.isFake = true;
    this.listeners = {};
    this.nextId = 1;
    this.t0 = performance.now();
    this.s = {
      video: { baseWidth: 1280, baseHeight: 720, outputWidth: 1280, outputHeight: 720, fpsNumerator: 30, fpsDenominator: 1 },
      scenes: new Map([['Szene', { items: [] }]]),
      inputs: new Map(),
      program: 'Szene',
      transitions: [
        { transitionName: 'Schnitt', transitionKind: 'cut_transition', transitionFixed: true },
        { transitionName: 'Überblenden', transitionKind: 'fade_transition', transitionFixed: false },
      ],
      transition: 'Überblenden',
      transitionMs: 300,
      fade: null, // { from, start }
      stream: { streamServiceType: 'rtmp_common', streamServiceSettings: {} },
      streaming: false, recording: false, streamStart: 0,
    };
    this.images = new Map(); // Dateipfad -> Image (für Logos)
    this.feedCanvas = new Map();
    this.devices = {
      video: [
        ['Logitech HD Pro Webcam C920', 'c920'],
        ['Integrierte Kamera', 'integrated'],
        ['Elgato Cam Link 4K (Camcorder per HDMI)', 'camlink'],
        ['OBS Virtual Camera', 'virtualcam'],
      ],
      audio: [
        ['Standard', 'default'],
        ['Mikrofon (RØDE NT-USB Mini)', 'ntusb'],
        ['Mikrofon (Realtek(R) Audio)', 'realtek'],
        ['Line In (Sennheiser EW-D Empfänger)', 'ewd'],
      ],
    };
    this.meterTimer = null;
  }

  // ---------- Ereignisse ----------
  on(ev, fn) { (this.listeners[ev] ||= new Set()).add(fn); }
  off(ev, fn) { this.listeners[ev]?.delete(fn); }
  emit(ev, data) { this.listeners[ev]?.forEach((fn) => fn(data)); }

  async connect() {
    await sleep(350);
    this.meterTimer = setInterval(() => this.emitMeters(), 50);
    return { obsWebSocketVersion: '5.5.2', negotiatedRpcVersion: 1 };
  }
  async disconnect() { clearInterval(this.meterTimer); this.emit('ConnectionClosed', {}); }

  err(code, message) { const e = new Error(message); e.code = code; throw e; }
  need(cond, code, msg) { if (!cond) this.err(code, msg); }

  // ---------- Befehle ----------
  async call(type, d = {}) {
    await sleep(8 + Math.random() * 18); // Netzwerk-/Verarbeitungszeit wie lokal
    const s = this.s;
    switch (type) {
      case 'GetVersion':
        return { obsVersion: '30.2.3', obsWebSocketVersion: '5.5.2', rpcVersion: 1, platform: 'windows', platformDescription: 'Windows 11 (Simulation)', availableRequests: [] };
      case 'GetVideoSettings': return { ...s.video };
      case 'SetVideoSettings':
        this.need(!s.streaming && !s.recording, 503, 'Ausgabe aktiv');
        Object.assign(s.video, d); return {};
      case 'GetInputKindList':
        return { inputKinds: ['dshow_input', 'wasapi_input_capture', 'wasapi_output_capture', 'image_source', 'color_source_v3', 'browser_source', 'ffmpeg_source', 'text_gdiplus_v3'] };
      case 'GetSceneList':
        return { currentProgramSceneName: s.program, currentPreviewSceneName: null, scenes: [...s.scenes.keys()].reverse().map((n, i) => ({ sceneName: n, sceneIndex: i })) };
      case 'CreateScene':
        this.need(!s.scenes.has(d.sceneName) && !s.inputs.has(d.sceneName), 601, `Quelle "${d.sceneName}" existiert bereits`);
        s.scenes.set(d.sceneName, { items: [] }); return { sceneUuid: uuid() };
      case 'RemoveScene':
        this.need(s.scenes.has(d.sceneName), 600, 'Szene nicht gefunden');
        s.scenes.delete(d.sceneName); if (s.program === d.sceneName) s.program = [...s.scenes.keys()][0]; return {};
      case 'GetInputList':
        return { inputs: [...s.inputs.entries()].map(([n, i]) => ({ inputName: n, inputKind: i.kind, unversionedInputKind: i.kind })) };
      case 'CreateInput': {
        this.need(s.scenes.has(d.sceneName), 600, 'Szene nicht gefunden');
        this.need(!s.inputs.has(d.inputName) && !s.scenes.has(d.inputName), 601, `Quelle "${d.inputName}" existiert bereits`);
        s.inputs.set(d.inputName, { kind: d.inputKind, settings: { ...(d.inputSettings || {}) }, filters: [], muted: false, born: performance.now() });
        const id = this.nextId++;
        s.scenes.get(d.sceneName).items.push({ sceneItemId: id, sourceName: d.inputName, enabled: d.sceneItemEnabled !== false, t: this.defaultTransform(d.inputName) });
        return { inputUuid: uuid(), sceneItemId: id };
      }
      case 'RemoveInput':
        this.need(s.inputs.has(d.inputName), 600, 'Quelle nicht gefunden');
        s.inputs.delete(d.inputName);
        for (const sc of s.scenes.values()) sc.items = sc.items.filter((it) => it.sourceName !== d.inputName);
        return {};
      case 'SetInputName': {
        const i = s.inputs.get(d.inputName); this.need(i, 600, 'Quelle nicht gefunden');
        this.need(!s.inputs.has(d.newInputName), 601, 'Name belegt');
        s.inputs.delete(d.inputName); s.inputs.set(d.newInputName, i);
        for (const sc of s.scenes.values()) sc.items.forEach((it) => { if (it.sourceName === d.inputName) it.sourceName = d.newInputName; });
        return {};
      }
      case 'GetInputSettings': { const i = s.inputs.get(d.inputName); this.need(i, 600, 'Quelle nicht gefunden'); return { inputKind: i.kind, inputSettings: { ...i.settings } }; }
      case 'SetInputSettings': { const i = s.inputs.get(d.inputName); this.need(i, 600, 'Quelle nicht gefunden'); Object.assign(i.settings, d.inputSettings); return {}; }
      case 'GetInputPropertiesListPropertyItems': {
        const i = s.inputs.get(d.inputName); this.need(i, 600, 'Quelle nicht gefunden');
        const list = i.kind === 'dshow_input' ? this.devices.video : this.devices.audio;
        return { propertyItems: list.map(([n, v]) => ({ itemName: n, itemValue: v, itemEnabled: true })) };
      }
      case 'GetInputMute': { const i = s.inputs.get(d.inputName); this.need(i, 600, 'Quelle nicht gefunden'); return { inputMuted: i.muted }; }
      case 'SetInputMute': { const i = s.inputs.get(d.inputName); this.need(i, 600, 'Quelle nicht gefunden'); i.muted = !!d.inputMuted; return {}; }
      case 'CreateSourceFilter': {
        const i = s.inputs.get(d.sourceName); this.need(i, 600, 'Quelle nicht gefunden');
        this.need(!i.filters.some((f) => f.filterName === d.filterName), 601, 'Filter existiert bereits');
        i.filters.push({ filterName: d.filterName, filterKind: d.filterKind, filterSettings: { ...(d.filterSettings || {}) }, filterEnabled: true }); return {};
      }
      case 'GetSourceFilterList': { const i = s.inputs.get(d.sourceName); this.need(i, 600, 'Quelle nicht gefunden'); return { filters: i.filters.map((f, k) => ({ ...f, filterIndex: k })) }; }
      case 'RemoveSourceFilter': { const i = s.inputs.get(d.sourceName); i.filters = i.filters.filter((f) => f.filterName !== d.filterName); return {}; }
      case 'CreateSceneItem': {
        const sc = s.scenes.get(d.sceneName); this.need(sc, 600, 'Szene nicht gefunden');
        this.need(s.inputs.has(d.sourceName) || s.scenes.has(d.sourceName), 600, 'Quelle nicht gefunden');
        const id = this.nextId++;
        sc.items.push({ sceneItemId: id, sourceName: d.sourceName, enabled: d.sceneItemEnabled !== false, t: this.defaultTransform(d.sourceName) });
        return { sceneItemId: id };
      }
      case 'RemoveSceneItem': { const sc = s.scenes.get(d.sceneName); sc.items = sc.items.filter((it) => it.sceneItemId !== d.sceneItemId); return {}; }
      case 'GetSceneItemList': {
        const sc = s.scenes.get(d.sceneName); this.need(sc, 600, 'Szene nicht gefunden');
        return { sceneItems: sc.items.map((it, k) => ({ sceneItemId: it.sceneItemId, sourceName: it.sourceName, sceneItemEnabled: it.enabled, sceneItemIndex: k, inputKind: s.inputs.get(it.sourceName)?.kind ?? null, sceneItemTransform: { ...it.t } })) };
      }
      case 'GetSceneItemTransform': { const it = this.item(d); return { sceneItemTransform: { ...it.t } }; }
      case 'SetSceneItemTransform': { const it = this.item(d); Object.assign(it.t, d.sceneItemTransform); return {}; }
      case 'SetSceneItemEnabled': { const it = this.item(d); it.enabled = d.sceneItemEnabled; return {}; }
      case 'SetSceneItemIndex': {
        const sc = s.scenes.get(d.sceneName); const it = this.item(d);
        sc.items = sc.items.filter((x) => x !== it); sc.items.splice(d.sceneItemIndex, 0, it); return {};
      }
      case 'GetCurrentProgramScene': return { currentProgramSceneName: s.program, sceneName: s.program };
      case 'SetCurrentProgramScene':
        this.need(s.scenes.has(d.sceneName), 600, 'Szene nicht gefunden');
        if (d.sceneName !== s.program) {
          const tr = s.transitions.find((t) => t.transitionName === s.transition);
          s.fade = tr?.transitionKind === 'fade_transition' ? { from: s.program, start: performance.now() } : null;
          s.program = d.sceneName;
          this.emit('CurrentProgramSceneChanged', { sceneName: d.sceneName });
        }
        return {};
      case 'GetSceneTransitionList': return { currentSceneTransitionName: s.transition, currentSceneTransitionKind: s.transitions.find((t) => t.transitionName === s.transition).transitionKind, transitions: s.transitions.map((t) => ({ ...t })) };
      case 'SetCurrentSceneTransition':
        this.need(s.transitions.some((t) => t.transitionName === d.transitionName), 600, 'Übergang nicht gefunden');
        s.transition = d.transitionName; return {};
      case 'SetCurrentSceneTransitionDuration': s.transitionMs = d.transitionDuration; return {};
      case 'GetStreamServiceSettings': return JSON.parse(JSON.stringify(s.stream));
      case 'SetStreamServiceSettings': s.stream = { streamServiceType: d.streamServiceType, streamServiceSettings: { ...d.streamServiceSettings } }; return {};
      case 'GetStreamStatus': return { outputActive: s.streaming, outputDuration: s.streaming ? performance.now() - s.streamStart : 0, outputSkippedFrames: 0, outputTotalFrames: s.streaming ? Math.round((performance.now() - s.streamStart) / 1000 * s.video.fpsNumerator) : 0 };
      case 'StartStream':
        this.need(!s.streaming, 500, 'Stream läuft bereits');
        this.need(s.stream.streamServiceSettings.key, 500, 'Kein Stream-Key gesetzt');
        s.streaming = true; s.streamStart = performance.now(); return {};
      case 'StopStream': s.streaming = false; return {};
      case 'StartRecord': s.recording = true; s.streamStart = performance.now(); return {};
      case 'StopRecord': s.recording = false; return { outputPath: 'C:\\Users\\Studio\\Videos\\2026-11-15 14-02-11.mkv' };
      case 'GetRecordStatus': return { outputActive: s.recording, outputDuration: s.recording ? performance.now() - s.streamStart : 0 };
      case 'GetSourceScreenshot': {
        const c = document.createElement('canvas');
        const w = d.imageWidth || 320; c.width = w; c.height = Math.round(w * 9 / 16);
        const ctx = c.getContext('2d');
        if (s.scenes.has(d.sourceName)) this.renderScene(ctx, d.sourceName, c.width, c.height);
        else { this.need(s.inputs.has(d.sourceName), 600, 'Quelle nicht gefunden'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height); this.drawSource(ctx, d.sourceName, 0, 0, c.width, c.height); }
        return { imageData: c.toDataURL('image/' + (d.imageFormat || 'png')) };
      }
      default:
        this.err(204, `Simulation kennt den Befehl ${type} nicht`);
    }
  }

  item(d) {
    const sc = this.s.scenes.get(d.sceneName); this.need(sc, 600, 'Szene nicht gefunden');
    const it = sc.items.find((x) => x.sceneItemId === d.sceneItemId); this.need(it, 600, 'Szenenelement nicht gefunden');
    return it;
  }
  srcSize(name) {
    const i = this.s.inputs.get(name);
    if (i?.kind === 'image_source') { const img = this.images.get(i.settings.file); return img ? [img.naturalWidth, img.naturalHeight] : [400, 160]; }
    if (i && isVideoKind(i.kind)) return [1920, 1080];
    return [0, 0];
  }
  defaultTransform(name) {
    const [w, h] = this.srcSize(name);
    return { positionX: 0, positionY: 0, alignment: 5, rotation: 0, scaleX: 1, scaleY: 1, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, boundsType: 'OBS_BOUNDS_NONE', boundsAlignment: 0, boundsWidth: 0, boundsHeight: 0, sourceWidth: w, sourceHeight: h, width: w, height: h };
  }

  // ---------- Ton ----------
  // Sprachähnlicher Pegel: Silben, Pausen. Ohne Filter liegen die Spitzen bei etwa −33 dBFS.
  rawLevelDb(name, t) {
    const seed = [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
    const syl = Math.sin(t * 7.3 + seed) * Math.sin(t * 2.1 + seed * 0.3);
    const pause = Math.sin(t * 0.55 + seed) > 0.82;
    if (pause) return -58 + Math.random() * 4;
    return -39 + Math.abs(syl) * 6 + Math.random() * 2.2 + (seed % 3) * 1.5;
  }
  processedDb(inp, db) {
    for (const f of inp.filters) {
      if (!f.filterEnabled) continue;
      const fs = f.filterSettings;
      if (f.filterKind.startsWith('noise_suppress') && db < -50) db -= 22;
      if (f.filterKind === 'compressor_filter' && db > fs.threshold) db = fs.threshold + (db - fs.threshold) / fs.ratio + (fs.output_gain || 0);
      if (f.filterKind === 'gain_filter') db += fs.db;
      if (f.filterKind === 'limiter_filter') db = Math.min(db, fs.threshold);
    }
    return db;
  }
  emitMeters() {
    const t = (performance.now() - this.t0) / 1000;
    const inputs = [];
    const aktiv = new Set((this.s.scenes.get(this.s.program)?.items || []).map((it) => it.sourceName));
    for (const [name, inp] of this.s.inputs) {
      if (!isAudioKind(inp.kind) || !aktiv.has(name)) continue;
      if (inp.muted) { inputs.push({ inputName: name, inputLevelsMul: [[0, 0, 0], [0, 0, 0]] }); continue; }
      const raw = this.rawLevelDb(name, t);
      const out = Math.min(0, this.processedDb(inp, raw));
      const m = Math.pow(10, out / 20), r = Math.pow(10, raw / 20);
      inputs.push({ inputName: name, inputLevelsMul: [[m * 0.6, m, r], [m * 0.58, m * 0.97, r]] });
    }
    this.emit('InputVolumeMeters', { inputs });
  }

  // ---------- Bild ----------
  feed(name) {
    // jede Videoquelle bekommt ein eigenes, animiertes Kamerabild (640x360)
    let c = this.feedCanvas.get(name);
    if (!c) { c = document.createElement('canvas'); c.width = 640; c.height = 360; this.feedCanvas.set(name, c); }
    const inp = this.s.inputs.get(name);
    drawCameraFeed(c.getContext('2d'), 640, 360, (performance.now() - this.t0) / 1000, inp, name);
    return c;
  }
  drawSource(ctx, name, x, y, w, h, crop = {}) {
    const inp = this.s.inputs.get(name); if (!inp) return;
    if (inp.kind === 'dshow_input' && !inp.settings.video_device_id) return; // Kamera abgezogen: schwarz
    if (isVideoKind(inp.kind)) {
      const f = this.feed(name); const sx = (crop.l || 0) / 1920 * 640, sr = (crop.r || 0) / 1920 * 640;
      const sy = (crop.t || 0) / 1080 * 360, sb = (crop.b || 0) / 1080 * 360;
      ctx.drawImage(f, sx, sy, 640 - sx - sr, 360 - sy - sb, x, y, w, h);
    } else if (inp.kind === 'image_source') {
      const img = this.images.get(inp.settings.file);
      if (img && img.complete) ctx.drawImage(img, x, y, w, h);
      else { ctx.fillStyle = '#c33'; ctx.fillRect(x, y, w, h); }
    }
  }
  itemRect(it, cw, ch) {
    // Rechteck in Leinwand-Pixeln (Basisauflösung), Ausrichtung links oben
    const t = it.t; const [sw0, sh0] = this.srcSize(it.sourceName);
    const sw = sw0 - (t.cropLeft || 0) - (t.cropRight || 0), sh = sh0 - (t.cropTop || 0) - (t.cropBottom || 0);
    if (t.boundsType && t.boundsType !== 'OBS_BOUNDS_NONE') {
      const bw = t.boundsWidth, bh = t.boundsHeight;
      let w = bw, h = bh;
      if (t.boundsType === 'OBS_BOUNDS_SCALE_INNER') { const k = Math.min(bw / sw, bh / sh); w = sw * k; h = sh * k; }
      if (t.boundsType === 'OBS_BOUNDS_SCALE_OUTER') { const k = Math.max(bw / sw, bh / sh); w = sw * k; h = sh * k; }
      return { x: t.positionX + (bw - w) / 2, y: t.positionY + (bh - h) / 2, w, h };
    }
    return { x: t.positionX, y: t.positionY, w: sw * (t.scaleX || 1), h: sh * (t.scaleY || 1) };
  }
  renderScene(ctx, sceneName, W, H, depth = 0) {
    const s = this.s; const sc = s.scenes.get(sceneName);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (!sc || depth > 3) return;
    const k = W / s.video.baseWidth;
    for (const it of sc.items) {
      if (!it.enabled) continue;
      const r = this.itemRect(it, s.video.baseWidth, s.video.baseHeight);
      const t = it.t;
      ctx.save();
      ctx.beginPath(); ctx.rect(r.x * k, r.y * k, r.w * k, r.h * k); ctx.clip();
      this.drawSource(ctx, it.sourceName, r.x * k, r.y * k, r.w * k, r.h * k, { l: t.cropLeft, r: t.cropRight, t: t.cropTop, b: t.cropBottom });
      ctx.restore();
    }
  }
  renderProgram(ctx, W, H) {
    const s = this.s;
    if (s.fade) {
      const p = (performance.now() - s.fade.start) / s.transitionMs;
      if (p >= 1) s.fade = null;
      else {
        this.renderScene(ctx, s.fade.from, W, H);
        const tmp = this._tmp ||= document.createElement('canvas'); tmp.width = W; tmp.height = H;
        this.renderScene(tmp.getContext('2d'), s.program, W, H);
        ctx.globalAlpha = p; ctx.drawImage(tmp, 0, 0); ctx.globalAlpha = 1; return;
      }
    }
    this.renderScene(ctx, s.program, W, H);
  }
}

function isVideoKind(k) { return /dshow_input|av_capture|v4l2|browser_source|color_source|ffmpeg_source_video|decklink/.test(k); }
function isAudioKind(k) { return /wasapi_input|coreaudio_input|pulse_input|alsa_input|ffmpeg_source/.test(k); }
function uuid() { return Math.random().toString(16).slice(2) + Date.now().toString(16); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Gezeichnetes Studiobild: Hintergrund, Tisch, abstrakte Person, Einblendung des Geräts
const FEED_LOOKS = {
  c920: { wall: ['#2b3a55', '#16213a'], shirt: '#d8a24a', skin: '#c99273', hair: '#3b2a20', x: 0.5, accent: '#5aa0ff' },
  integrated: { wall: ['#3d2f45', '#1d1626'], shirt: '#4f8a72', skin: '#e0b48f', hair: '#6b4a2e', x: 0.42, accent: '#c58bff' },
  camlink: { wall: ['#26403b', '#0f1f1c'], shirt: '#2f5fa8', skin: '#a8714f', hair: '#1a1210', x: 0.56, accent: '#4fd1b0' },
  virtualcam: { wall: ['#4a3a24', '#211808'], shirt: '#a8443c', skin: '#d9a07c', hair: '#8a5a2c', x: 0.5, accent: '#ffb347' },
  phone: { wall: ['#3a2a2a', '#1c1010'], shirt: '#6a6fb8', skin: '#b88466', hair: '#2a1c14', x: 0.48, accent: '#ff7a7a' },
};
function drawCameraFeed(ctx, W, H, t, inp, name) {
  const dev = inp?.settings?.video_device_id || (inp?.kind === 'browser_source' ? 'phone' : 'c920');
  const L = FEED_LOOKS[dev] || FEED_LOOKS.c920;
  const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, L.wall[0]); g.addColorStop(1, L.wall[1]);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // Hintergrund-Deko: Lichtpunkte / Regal
  ctx.globalAlpha = 0.18; ctx.fillStyle = L.accent;
  for (let i = 0; i < 6; i++) { const bx = ((i * 113 + 40) % W); ctx.beginPath(); ctx.arc(bx, 60 + (i % 3) * 38, 16 + (i % 2) * 10, 0, 7); ctx.fill(); }
  ctx.globalAlpha = 0.25; ctx.fillStyle = '#000'; ctx.fillRect(W * 0.08, H * 0.38, W * 0.22, 8); ctx.fillRect(W * 0.72, H * 0.3, W * 0.2, 8);
  ctx.globalAlpha = 1;
  // Person (leichtes Atmen / Kopfbewegung)
  const px = W * L.x + Math.sin(t * 0.7 + dev.length) * 6, py = H * 0.34 + Math.sin(t * 1.3) * 2;
  ctx.fillStyle = L.shirt;
  ctx.beginPath(); ctx.moveTo(px - 120, H); ctx.quadraticCurveTo(px - 115, py + 95, px, py + 88); ctx.quadraticCurveTo(px + 115, py + 95, px + 120, H); ctx.fill();
  ctx.fillStyle = L.skin; ctx.fillRect(px - 16, py + 50, 32, 42);
  ctx.beginPath(); ctx.ellipse(px, py + 18, 46, 56, 0, 0, 7); ctx.fill();
  ctx.fillStyle = L.hair; ctx.beginPath(); ctx.ellipse(px, py - 12, 49, 32, 0, Math.PI, 0); ctx.fill();
  // Mund bewegt sich, wenn "gesprochen" wird
  const talk = Math.max(0, Math.sin(t * 9 + dev.length) * Math.sin(t * 2.2));
  ctx.fillStyle = 'rgba(60,20,20,.75)'; ctx.beginPath(); ctx.ellipse(px, py + 44, 11, 2 + talk * 6, 0, 0, 7); ctx.fill();
  // Tisch
  ctx.fillStyle = 'rgba(15,15,18,.92)'; ctx.fillRect(0, H * 0.84, W, H * 0.16);
  ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(0, H * 0.84, W, 3);
}
