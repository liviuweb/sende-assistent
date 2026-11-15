// Baut alles zu einer einzigen Datei: index.html (Startseite für GitHub Pages)
// Aufruf: node build.js
const fs = require('fs');
const r = (p) => fs.readFileSync(__dirname + '/' + p, 'utf8');
const lib = r('obs-ws.global.js').replace(/<\/script/gi, '<\\/script'); // obs-websocket-js 5, Browser-Build
const app = ['fake-obs.js', 'core.js', 'ui.js'].map(r).join('\n');
const html = r('index.template.html')
  .replace('/*STYLE*/', () => r('style.css'))
  .replace('/*OBSWS*/', () => lib)
  .replace('/*APP*/', () => app);
fs.writeFileSync(__dirname + '/index.html', html);
console.log('index.html', (html.length / 1024).toFixed(1), 'KB');
