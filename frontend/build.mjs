// Dependency-free static build for degpu/web/. API requests remain same-origin.
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATIC_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.otf']);
const external = reference => /^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(reference);
const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function referencePath(reference, from) {
  if (!reference || external(reference)) return null;
  const clean = reference.split(/[?#]/, 1)[0];
  let decoded;
  try { decoded = decodeURIComponent(clean); } catch { throw new Error(`Invalid static reference: ${reference}`); }
  if (decoded.includes('\\') || decoded.includes('\0')) throw new Error(`Unsafe static reference: ${reference}`);
  const relative = decoded.startsWith('/') ? decoded.slice(1) : path.posix.join(path.posix.dirname(from), decoded);
  const normalized = path.posix.normalize(relative);
  if (!normalized.startsWith('src/') || normalized.split('/').some(part => part.startsWith('.'))
    || !STATIC_EXTENSIONS.has(path.posix.extname(normalized))) {
    throw new Error(`Only browser assets under src/ can be published: ${reference} (from ${from})`);
  }
  return normalized;
}

function htmlReferences(source) {
  const references = [];
  for (const match of source.matchAll(/<(script|link|img|source)\b[^>]*>/gi)) {
    const attributes = Object.fromEntries([...match[0].matchAll(/\b([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map(value => [value[1].toLowerCase(), value[3]]));
    const tag = match[1].toLowerCase();
    if (tag === 'script' && attributes.src) references.push(attributes.src);
    else if (tag === 'link' && ['stylesheet', 'icon', 'preload', 'modulepreload'].includes(attributes.rel)) references.push(attributes.href);
    else if ((tag === 'img' || tag === 'source') && attributes.src) references.push(attributes.src);
  }
  return references;
}

function moduleReferences(source) {
  const references = [];
  // This unbundled project uses literal ES module specifiers. Side-effect,
  // multiline and dynamic literal imports, and re-exports, stay supported.
  const statements = /(?:^|[;\r\n])\s*(?:import\s+(?:[^;]*?\s+from\s*)?|export\s+(?:\*|\{[^}]*\})\s+from\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(statements)) references.push(match[1]);
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) references.push(match[1]);
  for (const reference of references) {
    if (!external(reference) && !reference.startsWith('.') && !reference.startsWith('/')) {
      throw new Error(`A bare module import needs a bundler: ${reference}`);
    }
  }
  return references;
}

function cssReferences(source) {
  const references = [];
  for (const match of source.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/gi)) references.push(match[1]);
  for (const match of source.matchAll(/@import\s+["']([^"']+)["']/gi)) references.push(match[1]);
  return references;
}

export async function buildFrontend() {
  const root = await realpath(SOURCE_ROOT);
  const output = path.resolve(root, 'dist');
  // Recursive cleanup is permitted only for this exact, direct dist folder.
  if (path.dirname(output) !== root || path.basename(output) !== 'dist' || !within(root, output)) {
    throw new Error('Build output must be the frontend/dist directory.');
  }
  try {
    const info = await lstat(output);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(output) !== output) {
      throw new Error('Refusing to overwrite a linked or non-directory dist path.');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const files = new Map();
  const pending = ['index.html'];
  while (pending.length) {
    const relative = pending.shift();
    if (files.has(relative)) continue;
    const absolute = path.resolve(root, relative);
    const canonical = await realpath(absolute);
    if (!within(root, canonical) || (relative !== 'index.html' && !within(path.join(root, 'src'), canonical))) {
      throw new Error(`Static asset points outside the source folder: ${relative}`);
    }
    const body = await readFile(canonical);
    files.set(relative, body);
    const extension = path.extname(relative);
    const references = relative === 'index.html' ? htmlReferences(body.toString('utf8'))
      : ['.js', '.mjs'].includes(extension) ? moduleReferences(body.toString('utf8'))
        : extension === '.css' ? cssReferences(body.toString('utf8')) : [];
    for (const reference of references) {
      const dependency = referencePath(reference, relative);
      if (dependency && !files.has(dependency)) pending.push(dependency);
    }
  }

  // Validate the complete graph before replacing an earlier successful build.
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const [relative, body] of files) {
    const destination = path.resolve(output, relative);
    if (!within(output, destination)) throw new Error(`Invalid output asset: ${relative}`);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, body);
  }
  return { output, files: [...files.keys()].sort(), bytes: [...files.values()].reduce((sum, body) => sum + body.length, 0) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length > 2) throw new Error('The build takes no arguments; output is always frontend/dist.');
  const result = await buildFrontend();
  console.log(`Built ${result.files.length} static files (${result.bytes} bytes) in ${result.output}`);
}
