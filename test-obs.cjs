// Durchlauf gegen ein echtes OBS Studio (WebSocket auf localhost:4455).
// Ohne Kamera-Hardware: Testbild-Quellen und eine Audiodatei als Mikrofon.
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const dist = __dirname;
const out = require('os').tmpdir(); // Testbilder landen außerhalb des Repos
const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(fs.readFileSync(path.join(dist, 'index.html'))); }).listen(8080);
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const fehler = [];
  global.P = p;
  p.on('pageerror', (e) => fehler.push(e.message));
  await p.goto('http://localhost:8080/?ohnekamerasuche&testaudio=' + encodeURIComponent(process.env.WAV || '/tmp/sprache.wav'));
  await p.selectOption('#qualitaet', '1080p30');
  await p.click('#verbinden');
  await p.waitForSelector('section[data-s="1"].aktiv', { timeout: 15000 });
  console.log('OBS:', await p.textContent('#obsVersion'));
  console.log('Kamera-Optionen:', await p.$$eval('#kamListe select option', (o) => [...new Set(o.map((x) => x.textContent))]));
  await p.selectOption('#anzM', '1');
  await p.click('#quellenAnlegen');
  await p.waitForFunction(() => !document.querySelector('#weiter1').disabled, null, { timeout: 15000 });
  await p.click('#weiter1');
  await p.click('#tonListe button');
  await p.waitForSelector('#tonListe .vergleich, #tonListe .fehlerbox', { timeout: 20000 });
  console.log('Ton:', (await p.textContent('#tonListe .ergebnis')).replace(/\s+/g, ' '));
  await p.click('#weiter2');
  await p.click('#szenenBauen');
  await p.waitForFunction(() => !document.querySelector('#weiter3').disabled, null, { timeout: 15000 });
  await p.click('#weiter3');
  await p.fill('#logoPfad', '/tmp/logo.png');
  await p.click('#logoEinfuegen');
  await p.waitForSelector('#kollision .warnbox, #kollision .okbox', { timeout: 15000 });
  console.log('Kollision:', (await p.textContent('#kollision')).replace(/\s+/g, ' ').slice(0, 160));
  if (await p.$('#verschieben')) { await p.click('#verschieben'); await p.waitForSelector('#kollision .okbox'); console.log('Nachher:', await p.textContent('#kollision')); }
  await p.click('#weiter4');
  await p.check('#nurAufnahme');
  await p.click('#pruefen');
  await p.waitForFunction(() => document.querySelectorAll('#ampel .p').length > 0, null, { timeout: 20000 });
  console.log('Ampel:', await p.$$eval('#ampel .p', (v) => v.map((x) => x.className.split(' ')[1] + ' ' + x.querySelector('b').textContent + ': ' + x.querySelector('span').textContent).join(' | ')));
  await p.waitForTimeout(1500);
  await p.screenshot({ path: out + '/echt_5_startcheck.png' });
  await p.click('#liveGehen');
  await p.waitForSelector('section[data-s="6"].aktiv');
  await p.waitForTimeout(1500);
  await p.keyboard.press('3'); await p.waitForTimeout(2500);
  await p.screenshot({ path: out + '/echt_6_live.png' });
  await p.keyboard.press('4'); await p.waitForTimeout(800);
  await p.click('#beenden');
  await p.waitForSelector('section[data-s="7"].aktiv');
  console.log('Zahlen:', await p.$$eval('.zahl', (v) => v.map((x) => x.textContent.trim()).join(' | ')));
  const fehlgeschlagen = await p.$$eval('#log .no', (v) => v.map((x) => x.closest('.e').textContent + ' ' + x.closest('.e').title));
  console.log('Fehlgeschlagene Befehle:', fehlgeschlagen.length ? fehlgeschlagen : 'keine');
  console.log('Seitenfehler:', fehler.length ? fehler : 'keine');
  await b.close(); srv.close();
})().catch(async (e) => { console.error(e.message.split('\n')[0]); try { const p = (await (await require('playwright')).chromium) && null; } catch {} console.log('Fehlerbox:', await global.P.textContent('section.aktiv .fehlerbox').catch(() => '-')); console.log('Log-Ende:', (await global.P.$$eval('#log > *', (v) => v.slice(-6).map((x) => x.textContent + ' ' + (x.title || '')))).join('\n')); process.exit(1); });
