#!/usr/bin/env node
import { realpath, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildFileLink } from '../apps/web/lib/workspace-links.ts';
import { rawFileReadUrl } from '../apps/web/lib/workspace-paths.ts';

const formats = {
  '.md': ['text/markdown', 'markdown'],
  '.txt': ['text/plain', 'rich-text'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'rich-text'],
  '.csv': ['text/csv', 'spreadsheet'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'spreadsheet'],
  '.json': ['application/json', 'code'],
  '.js': ['text/javascript', 'code'],
  '.ts': ['text/typescript', 'code'],
  '.py': ['text/x-python', 'code'],
  '.css': ['text/css', 'code'],
};

/** Operator-only helper. workspace is an intended boundary, NOT a client access grant. */
export async function deliverDocument({ workspace, file, title, origin = 'https://crm.rebattery.io' }) {
  if (!workspace || !path.isAbsolute(workspace)) throw new Error('--workspace must be an explicit absolute directory');
  if (!file) throw new Error('--file is required');
  const base = new URL(origin);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('--origin must be an HTTP(S) origin without credentials, path, query or fragment');
  }
  const root = await realpath(workspace);
  if (!(await stat(root)).isDirectory()) throw new Error('Workspace is not a directory');
  const exactPath = await realpath(path.resolve(root, file));
  const relativePath = path.relative(root, exactPath);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error('File is outside the intended workspace');
  }
  if (!(await stat(exactPath)).isFile()) throw new Error('Document must be a regular file');
  const format = formats[path.extname(exactPath).toLowerCase()];
  if (!format) throw new Error('Unsupported document type');
  const bytes = await readFile(exactPath);
  const openPath = buildFileLink(exactPath);
  return {
    schemaVersion: 1,
    kind: 'workspace-document',
    workspace: { root },
    path: exactPath,
    relativePath,
    title: title || path.basename(exactPath),
    mimeType: format[0],
    editor: format[1],
    capabilities: { open: true, edit: true },
    revision: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    openPath,
    openUrl: new URL(openPath, base).href,
    retrievalUrl: new URL(rawFileReadUrl(exactPath), base).href,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node --experimental-strip-types scripts/document-delivery.mjs --workspace /absolute/intended/workspace --file relative-or-absolute-file [--title Title] [--origin https://crm.rebattery.io]\nPrints a versioned JSON artifact. Return openUrl as a Markdown link in the chat result. No upload, registration or access grant is performed.');
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!['workspace', 'file', 'title', 'origin'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid option: ${args[i]}`);
    options[key] = args[i + 1];
  }
  console.log(JSON.stringify(await deliverDocument(options), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`document-delivery: ${error.message}`); process.exitCode = 1; });
}
