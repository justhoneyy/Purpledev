/* Builds the protected version of the site.
 *   src/index.html, src/admin.html   readable originals (keep these PRIVATE)
 *   -> dist/index.html, dist/admin.html   tiny shells (what "view source" shows)
 *   -> dist/assets/main.js, dist/assets/panel.js   minified + scrambled code, CSS and markup
 * Usage:  npm i esbuild   then   node build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { transformSync } from 'esbuild';

const SRC = 'src', OUT = 'dist';
const pages = [
  { file: 'index.html', bundle: 'main.js' },
  { file: 'admin.html', bundle: 'panel.js' },
];

fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });

for (const { file, bundle } of pages) {
  const html = fs.readFileSync(path.join(SRC, file), 'utf8');

  // 1) pull the page apart: <style> in head, <body ...>markup</body>, last inline <script>
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  if (styles.length !== 1) throw new Error(`${file}: expected exactly one <style>`);
  const css = styles[0][1];

  const bodyOpen = html.match(/<body[^>]*>/);
  const bodyStart = bodyOpen.index + bodyOpen[0].length;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].filter((m) => m.index > bodyStart);
  if (scripts.length !== 1) throw new Error(`${file}: expected exactly one inline <script> in body`);
  const js = scripts[0][1];
  const markup = html.slice(bodyStart, scripts[0].index).replace(/<!--[\s\S]*?-->/g, '');
  if (/<script/i.test(markup)) throw new Error(`${file}: unexpected <script> inside body markup`);

  // 2) minify (no behaviour change)
  const jsMin = transformSync(js, { minify: true, legalComments: 'none' }).code;
  const cssMin = transformSync(css, { loader: 'css', minifyWhitespace: true, legalComments: 'none' }) /* whitespace only: values are never rewritten */.code;

  // 3) scramble: JSON (pure ASCII) -> ROT47-style shift by a random amount.
  //    (a plain character shift keeps the text compressible, so gzip on the server still works well)
  const shift = 1 + Math.floor(Math.random() * 92);
  const json = JSON.stringify({ c: cssMin, h: markup, j: jsMin })
    .replace(/[\u0080-\uffff]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  const scrambled = json.replace(/[!-~]/g, (ch) => String.fromCharCode(33 + ((ch.charCodeAt(0) - 33 + shift) % 94)));

  // 4) loader (runs synchronously, at the same point the old inline <script> ran)
  const loader =
    `(function(){var s=${JSON.stringify(scrambled)},n=${94 - shift},` +
    `o=JSON.parse(s.replace(/[!-~]/g,function(c){return String.fromCharCode(33+(c.charCodeAt(0)-33+n)%94)})),` +
    `t=document.getElementById("_s");if(t)t.textContent=o.c;` +
    `document.body.insertAdjacentHTML("afterbegin",o.h);(new Function(o.j))()})();`;
  fs.writeFileSync(path.join(OUT, 'assets', bundle), loader);
  const v = crypto.createHash('sha1').update(loader).digest('hex').slice(0, 8);

  // 5) shell: original head untouched, empty <style id="_s"> in the same spot, original <body> tag, one script
  const shell = (html.slice(0, styles[0].index) + '<style id="_s"></style>' +
    html.slice(styles[0].index + styles[0][0].length, bodyStart) +
    `<script src="/assets/${bundle}?v=${v}"></script>\n</body>\n</html>\n`).replace(/^\s+/, '');
  fs.writeFileSync(path.join(OUT, file), shell);
  console.log(file, '->', bundle, `(${(loader.length / 1024).toFixed(0)} KB)`, 'shell', shell.length, 'bytes');
}
