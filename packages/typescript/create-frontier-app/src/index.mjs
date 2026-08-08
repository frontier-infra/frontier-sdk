import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_ROOT = path.join(PACKAGE_ROOT, 'template');
const TEMPLATE_SOURCE_BY_TARGET = Object.freeze({
  '.gitignore': 'gitignore.template',
  'public/.agent': 'root.agent',
  'public/.well-known/agent-view': 'root.agent',
  'public/.well-known/avl': 'root.agent',
});

export const TEMPLATE_MANIFEST = Object.freeze([
  '.env.example',
  '.gitignore',
  'README.md',
  'config/production.reference.env',
  'docker-compose.local.yml',
  'docker-compose.production.reference.yml',
  'index.html',
  'package.json',
  'public/.agent',
  'public/.well-known/agent-view',
  'public/.well-known/avl.json',
  'public/.well-known/avl',
  'public/agent.txt',
  'public/llms.txt',
  'scripts/dev.mjs',
  'server/config.mjs',
  'server/goal.example.json',
  'server/index.mjs',
  'src/App.jsx',
  'src/main.jsx',
  'src/styles.css',
  'vite.config.mjs',
]);

function assertSafeManifestEntry(entry) {
  if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
    throw new Error(`unsafe template entry: ${entry}`);
  }
}

export function sanitizePackageName(name) {
  const normalized = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .replace(/-{2,}/g, '-');
  return normalized || 'frontier-governed-worker';
}

function directoryEntries(targetDir) {
  try {
    return fs.readdirSync(targetDir);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function validateTargetDir(targetDir, options = {}) {
  if (typeof targetDir !== 'string' || !targetDir.trim()) {
    throw new Error('target-dir is required');
  }
  if (targetDir.startsWith('-')) {
    throw new Error('target-dir cannot look like an option');
  }
  if (targetDir.split(/[\\/]+/).includes('..')) {
    throw new Error('target-dir cannot contain parent-directory segments');
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const resolved = path.resolve(cwd, targetDir);
  const relative = path.relative(cwd, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('target-dir must be a child directory of the current working directory');
  }
  if (resolved === path.parse(resolved).root) {
    throw new Error('refusing to scaffold into a filesystem root');
  }
  if (resolved === process.env.HOME) {
    throw new Error('refusing to scaffold directly into HOME');
  }
  let stat = null;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (stat?.isFile()) throw new Error('target-dir exists and is a file');
  if (stat?.isSymbolicLink()) throw new Error('target-dir cannot be a symbolic link');

  const entries = directoryEntries(resolved);
  if (entries && entries.length > 0) {
    throw new Error('target-dir must be empty; existing files are never overwritten');
  }
  return resolved;
}

function renderTemplate(content, replacements) {
  return content
    .replaceAll('__PROJECT_NAME__', replacements.projectName)
    .replaceAll('__PACKAGE_NAME__', replacements.packageName);
}

function writeTemplateFile(entry, targetDir, replacements) {
  assertSafeManifestEntry(entry);
  const sourceEntry = TEMPLATE_SOURCE_BY_TARGET[entry] ?? entry;
  assertSafeManifestEntry(sourceEntry);
  const sourcePath = path.join(TEMPLATE_ROOT, sourceEntry);
  const targetPath = path.join(targetDir, entry);
  const targetRelative = path.relative(targetDir, targetPath);
  if (targetRelative.startsWith('..') || path.isAbsolute(targetRelative)) {
    throw new Error(`unsafe target path for template entry: ${entry}`);
  }
  const sourceStat = fs.lstatSync(sourcePath);
  if (!sourceStat.isFile()) throw new Error(`template entry is not a regular file: ${entry}`);
  if (fs.existsSync(targetPath)) throw new Error(`refusing to overwrite ${entry}`);

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const rendered = renderTemplate(fs.readFileSync(sourcePath, 'utf8'), replacements);
  fs.writeFileSync(targetPath, rendered, { mode: sourceStat.mode & 0o777 });
}

export function scaffoldProject(targetDir, options = {}) {
  const resolved = validateTargetDir(targetDir, options);
  const projectName = sanitizePackageName(options.projectName ?? path.basename(resolved));
  fs.mkdirSync(resolved, { recursive: true });
  for (const entry of TEMPLATE_MANIFEST) {
    writeTemplateFile(entry, resolved, { projectName, packageName: projectName });
  }
  return {
    targetDir: resolved,
    projectName,
    files: [...TEMPLATE_MANIFEST],
  };
}

export function formatNextSteps(result) {
  const relativeTarget = path.relative(process.cwd(), result.targetDir) || result.targetDir;
  return [
    '',
    'Next steps:',
    `  cd ${relativeTarget}`,
    '  Install dependencies with your package manager:',
    '    npm install',
    '    pnpm install',
    '    yarn install',
    '  Start the local harness and Vite app:',
    '    npm run dev',
    '',
    'The compose and production-reference config files are illustrative starting points, not a production implementation.',
  ].join('\n');
}
