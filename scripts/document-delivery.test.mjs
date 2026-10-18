import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { deliverDocument } from './document-delivery.mjs';

const scratch = process.env.TMPDIR;
if (!scratch) throw new Error('Set TMPDIR to an approved disposable scratch directory');
test('document delivery CLI and containment boundary', async () => {
  const dir = await mkdtemp(path.join(scratch, 'document-delivery-'));
  try {
    const workspace = path.join(dir, 'workspace');
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'hello.md'), '# Hello\n');
    await writeFile(path.join(dir, 'outside.md'), 'outside');
    await symlink(path.join(dir, 'outside.md'), path.join(workspace, 'escape.md'));
    const options = { workspace, file: 'hello.md' };
    const a = await deliverDocument(options);
    assert.deepEqual(a, await deliverDocument(options));
    assert.equal(a.editor, 'markdown');
    assert.equal(a.mimeType, 'text/markdown');
    assert.equal(new URL(a.openUrl).searchParams.get('path'), a.path);
    assert.equal(new URL(a.retrievalUrl).searchParams.get('path'), a.path);
    assert.equal(new URL(a.retrievalUrl).pathname, '/api/workspace/browse-file');
    const output = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/document-delivery.mjs', '--workspace', workspace, '--file', 'hello.md'], { encoding: 'utf8' }));
    assert.deepEqual(output, a);
    await writeFile(path.join(workspace, 'hello.md'), '# Changed\n');
    assert.notEqual((await deliverDocument(options)).revision, a.revision);
    for (const file of ['missing.md', '../outside.md', 'escape.md', '.']) {
      await assert.rejects(deliverDocument({ workspace, file }));
    }
    await writeFile(path.join(workspace, 'slides.pptx'), 'not supported');
    await assert.rejects(deliverDocument({ workspace, file: 'slides.pptx' }), /Unsupported/);
    await assert.rejects(deliverDocument({ ...options, workspace: 'relative' }));
    await assert.rejects(deliverDocument({ ...options, origin: 'https://foreign.test/path' }));
    for (const [name, editor] of [['notes.txt', 'rich-text'], ['report.docx', 'rich-text'], ['data.csv', 'spreadsheet'], ['data.xlsx', 'spreadsheet'], ['data.json', 'code']]) {
      await writeFile(path.join(workspace, name), 'synthetic metadata fixture');
      assert.equal((await deliverDocument({ workspace, file: name })).editor, editor);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
