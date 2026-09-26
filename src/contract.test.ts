// writeContract over a fake file system: what lands, what is deleted, and
// what is never touched — mirroring test_files.py's contract cases.
import assert from 'node:assert/strict';
import { writeContract, type PathIO } from './contract.ts';
import { ARTIFACT_MANIFEST } from './artifacts.ts';

function fakeFS(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const io: PathIO = {
    read: async (path) => files.get(path) ?? null,
    write: async (path, text) => {
      files.set(path, text);
      return true;
    },
    remove: async (path) => {
      files.delete(path);
      return true;
    },
  };
  return { files, io };
}

const root = '/p/paper';

// First write: values, figures, and the manifest that owns them.
{
  const { files, io } = fakeFS({ [`${root}/figs/theirs.svg`]: '<svg/>' });
  await writeContract(root, { a: 1 }, { mine: '<svg>1</svg>' }, io);
  assert.equal(files.get(`${root}/values.json`), '{\n  "a": 1\n}\n');
  assert.equal(files.get(`${root}/figs/mine.svg`), '<svg>1</svg>');
  assert.ok(files.get(`${root}/${ARTIFACT_MANIFEST}`)!.includes('figs/mine.svg'));

  // Second write: ours and now stale is removed; theirs was never ours.
  await writeContract(root, {}, { other: '<svg>2</svg>' }, io);
  assert.equal(files.has(`${root}/figs/mine.svg`), false);
  assert.equal(files.has(`${root}/figs/theirs.svg`), true);
  assert.equal(files.get(`${root}/figs/other.svg`), '<svg>2</svg>');
  assert.equal(files.get(`${root}/values.json`), '{}\n');
}

// A malformed manifest owns nothing: pre-existing SVGs survive.
{
  const { files, io } = fakeFS({
    [`${root}/${ARTIFACT_MANIFEST}`]: '{"version": 99, "figures": ["figs/old.svg"]}',
    [`${root}/figs/old.svg`]: '<svg/>',
  });
  await writeContract(root, {}, {}, io);
  assert.equal(files.has(`${root}/figs/old.svg`), true);
}

// An unsafe name is refused before anything is written.
{
  const { files, io } = fakeFS();
  await assert.rejects(() => writeContract(root, {}, { '../escape': '<svg/>' }, io), /unsafe/);
  assert.equal(files.size, 0);
}

// A failed write surfaces instead of claiming ownership.
{
  const { files, io } = fakeFS();
  const failing: PathIO = { ...io, write: async () => false };
  await assert.rejects(() => writeContract(root, { a: 1 }, {}, failing), /values.json/);
  assert.equal(files.size, 0);
}

console.log('contract.test: all assertions passed');
