import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, '_site');
const manifest = JSON.parse(fs.readFileSync(path.join(SITE, 'build-info.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/catalog.json'), 'utf8'));
assert.match(manifest.commit, /^[a-f0-9]{40}$/);
const revision = process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
assert.equal(manifest.commit, revision, 'Build is from a different commit; rebuild first.');
assert.deepEqual(manifest.sections, Object.fromEntries(catalog.sections.map(section => [section.id, section.works.length])));
function currentSource(relativePath) {
  let content = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  if (relativePath === 'assets/js/app.js' || relativePath === 'index.html') {
    for (const [source, emitted] of Object.entries(manifest.files)) {
      if (source !== relativePath) content = content.replaceAll(source, emitted);
    }
    content = content.replaceAll('__ARCHIVE_COMMIT__', manifest.commit);
  }
  return content;
}
let bytes = 0;
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    assert(!entry.isSymbolicLink(), 'No symlinks may be deployed.');
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
const deployed = walk(SITE);
const expectedImages = [...new Set(catalog.sections.flatMap(section => [section.avatar, ...section.works.map(work => work.preview)]).map(decodeURIComponent))];
const expectedFiles = new Set(['index.html', '.nojekyll', 'build-info.json', ...Object.values(manifest.files), ...expectedImages]);
assert.equal(deployed.length, expectedFiles.size, 'Unexpected website file count.');
for (const file of deployed) {
  const relative = path.relative(SITE, file).replaceAll('\\', '/');
  assert(expectedFiles.has(relative), 'Unexpected deployed file: ' + relative);
  assert(!/\.png$/i.test(file), 'Original PNG cards must stay out of Pages.');
  assert(!/(^|\/)(node_modules|\.git|tests|scripts)(\/|$)/.test(relative));
  assert(!relative.includes('card-intros'), 'Editorial source is not a website asset.');
  bytes += fs.statSync(file).size;
}
for (const relative of expectedImages) {
  assert(fs.readFileSync(path.join(SITE, relative)).equals(fs.readFileSync(path.join(ROOT, relative))), 'Stale website image; rebuild: ' + relative);
}
for (const [source, emitted] of Object.entries(manifest.files)) {
  const content = fs.readFileSync(path.join(SITE, emitted));
  assert(content.equals(Buffer.from(currentSource(source))), 'Stale generated asset; rebuild: ' + source);
  const digest = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  assert(emitted.includes('.' + digest + '.'), 'Fingerprint mismatch: ' + source);
  if (/\.(js|css)$/.test(source)) {
    assert(!content.toString().includes('fanhuafenluo-pages'), 'Old repository dependency remains: ' + source);
    assert(!content.toString().includes('__ARCHIVE_COMMIT__'), 'Unresolved build marker: ' + source);
  }
}
const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
assert(html === currentSource('index.html'), 'Stale HTML; rebuild first.');
assert(!html.includes('fanhuafenluo-pages'));
assert(!fs.existsSync(path.join(SITE, 'index-inertia.html')));
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const url = match[1].split('?')[0];
  if (/^(https?:|data:|#|mailto:)/.test(url)) continue;
  assert(fs.existsSync(path.join(SITE, decodeURIComponent(url))), 'Missing HTML asset: ' + url);
}
const app = fs.readFileSync(path.join(SITE, manifest.files['assets/js/app.js']), 'utf8');
assert(app.includes(manifest.commit), 'Download URLs are not pinned to the deployed commit.');
for (const section of catalog.sections) {
  assert(fs.existsSync(path.join(SITE, decodeURIComponent(section.avatar))));
  for (const work of section.works) {
    assert(fs.existsSync(path.join(SITE, decodeURIComponent(work.preview))), 'Missing preview asset.');
  }
}
assert(bytes < 100 * 1024 * 1024, 'Unexpected Pages artifact growth.');
console.log(JSON.stringify({ verified: true, files: deployed.length, bytes, sections: manifest.sections }));
