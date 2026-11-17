import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { act, node, nodes, setup, textOf } from './client-harness.mjs';
import { loadClientModule } from './client-module-loader.mjs';

const formatter = async () => (await loadClientModule('fileSize')).formatFileSize;

test('file sizes use compact binary K/M/G values at every boundary', async () => {
  const format = await formatter();
  const cases = [
    [0, '0K'],
    [1, '0.1K'],
    [100, '0.1K'],
    [512, '0.5K'],
    [1023, '1K'],
    [1024, '1K'],
    [1536, '1.5K'],
    [1_048_575, '1M'],
    [1_048_576, '1M'],
    [1_572_864, '1.5M'],
    [1_073_741_823, '1G'],
    [1_073_741_824, '1G'],
    [2_147_483_648, '2G'],
  ];
  for (const [bytes, expected] of cases) {
    const actual = format(bytes);
    assert.equal(actual, expected, `${bytes} bytes must render as ${expected}`);
    assert.doesNotMatch(actual, /B|字节|1024[KM]/, `${actual} must not expose a byte suffix or an un-promoted unit boundary`);
  }
});

test('the directory list renders file sizes through the compact formatter and leaves directories size-less', async t => {
  const view = await setup(t, {
    seed: async root => {
      await writeFile(path.join(root, 'empty.bin'), Buffer.alloc(0));
      await writeFile(path.join(root, 'kilo.bin'), Buffer.alloc(1024, 0x61));
      await writeFile(path.join(root, 'mega.bin'), Buffer.alloc(1024 * 1024, 0x61));
    },
  });

  const files = new Map(nodes(view.renderer, { 'data-fm-entry': 'file' }).map(row => [
    row.props['data-fm-path'],
    textOf(row.findAllByProps({ className: 'fm-size' })[0]),
  ]));
  assert.equal(files.get('empty.bin'), '0K');
  assert.equal(files.get('kilo.bin'), '1K');
  assert.equal(files.get('mega.bin'), '1M');
  const directory = node(view.renderer, { 'data-fm-entry': 'directory', 'data-fm-path': 'folder' });
  assert.equal(directory.findAllByProps({ className: 'fm-size' }).length, 0, 'a directory has no returned size to display');
  assert.doesNotMatch(textOf(view.renderer.root), /字节|bytes/);
});

test('the upload review summary uses the same compact formatter', async t => {
  const view = await setup(t, { transfers: true });
  const files = [
    new File([new Uint8Array(1024)], 'first.bin'),
    new File([new Uint8Array(1024)], 'second.bin'),
  ];
  await act(async () => {
    await node(view.renderer, { 'data-fm-upload-files': true }).props.onChange({ target: { files, value: '' } });
  });
  await view.flush();

  const dialog = node(view.renderer, { role: 'dialog', 'aria-label': '核对上传内容' });
  const summary = dialog.findAllByType('p').find(candidate => textOf(candidate).startsWith('2 项'));
  assert.ok(summary, 'the upload review must render its item and total-size summary');
  assert.equal(textOf(summary), '2 项 · 2K');
  assert.doesNotMatch(textOf(dialog), /字节|bytes/);
});
