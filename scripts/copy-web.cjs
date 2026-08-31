// Gera www/ com a web do FlowPilot (o Capacitor copia www/ para os assets do Android).
// O Capacitor 8 não aceita webDir "." na raiz (causava recursão). Rode: npm run web:www
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'www');

const ARQUIVOS = [
  'index.html',
  'app.js',
  'styles.css',
  'sw.js',
  'manifest.json',
  'config.local.js' // chave TomTom local (não vai para o git, mas vai para o APK de dev)
];

const PASTA = ['icons'];

if (!fs.existsSync(WWW)) fs.mkdirSync(WWW, { recursive: true });

for (const f of ARQUIVOS) {
  fs.copyFileSync(path.join(ROOT, f), path.join(WWW, f));
}
for (const p of PASTA) {
  fs.cpSync(path.join(ROOT, p), path.join(WWW, p), { recursive: true });
}
console.log('www/ gerado (index.html, app.js, styles.css, sw.js, manifest.json, config.local.js, icons/).');