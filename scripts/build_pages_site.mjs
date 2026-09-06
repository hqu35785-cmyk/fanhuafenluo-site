import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertCatalog, resolveRepositoryPath } from './lib/chara-card.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, '_site');
const catalog = assertCatalog(JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/catalog.json'), 'utf8')));
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
const revision = process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('A full Git commit SHA is required to build the site.');
if (fs.existsSync(SITE) && fs.lstatSync(SITE).isSymbolicLink()) throw new Error('_site must not be a symbolic link.');
if (path.dirname(SITE) !== ROOT) throw new Error('Build output escapes the repository.');

// Only generated output is replaced. Original cards never enter the Pages artifact.
fs.rmSync(SITE, { recursive: true, force: true });
fs.mkdirSync(SITE);
const files = {};
function emit(source, transform = value => value) {
  const content = transform(fs.readFileSync(path.join(ROOT, source), 'utf8'));
  const extension = path.extname(source);
  const target = source.slice(0, -extension.length) + '.' + hash(content) + extension;
  fs.mkdirSync(path.dirname(path.join(SITE, target)), { recursive: true });
  fs.writeFileSync(path.join(SITE, target), content);
  files[source] = target;
}
function rewriteReferences(text) {
  for (const [source, target] of Object.entries(files)) {
    text = text.replaceAll(source, target);
  }
  return text.replaceAll('__ARCHIVE_COMMIT__', revision);
}

for (const file of ['src/data/catalog.json', 'src/data/details-fanhua.json', 'src/data/details-public.json', 'assets/css/site.css', 'assets/css/motion.css', 'assets/js/motion.js']) emit(file);
emit('assets/js/app.js', rewriteReferences);
const html = rewriteReferences(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
fs.writeFileSync(path.join(SITE, 'index.html'), html);
fs.writeFileSync(path.join(SITE, '.nojekyll'), '');
const publicImages = new Set(catalog.sections.flatMap(section => [section.avatar, ...section.works.map(work => work.preview)]));
for (const asset of publicImages) {
  const { relativePath, absolutePath } = resolveRepositoryPath(ROOT, asset);
  if (!/^assets\/(authors|previews)\/.+\.webp$/i.test(relativePath)) throw new Error('Unexpected website image path.');
  if (fs.lstatSync(absolutePath).isSymbolicLink() || !fs.realpathSync(absolutePath).startsWith(fs.realpathSync(ROOT) + path.sep)) throw new Error('Website image must be a repository file.');
  const output = path.join(SITE, relativePath);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(absolutePath, output);
}
const manifest = {
  schemaVersion: 1,
  commit: revision,
  files,
  sections: Object.fromEntries(catalog.sections.map(section => [section.id, section.works.length])),
};
fs.writeFileSync(path.join(SITE, 'build-info.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ output: '_site', commit: revision, sections: manifest.sections, fingerprintedFiles: Object.keys(files).length }));
