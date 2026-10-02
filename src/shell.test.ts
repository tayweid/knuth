// connectShell against fake hosts: the Claerbout bridge, and a plain tab
// without one.
import assert from 'node:assert/strict';
import {
  answerRewinds,
  connectShell,
  historyNote,
  reportCellRun,
  rewindNote,
  samePath,
  type RewindPage,
  type ShellHost,
  type ShellMessage,
} from './shell.ts';

// A plain tab: no shell.
assert.equal(connectShell({}), null);

// The Claerbout bridge: requests are promises; a rejected one reads as no
// answer, the way a missing shell does.
{
  const sent: ShellMessage[] = [];
  const listeners = new Map<string, (detail: unknown) => void>();
  const host: ShellHost = {
    claerbout: {
      request: async (message) => {
        sent.push(message);
        if (message.type === 'open') return { path: '/p/a.py' };
        if (message.type === 'saveAs') return { path: null };
        if (message.type === 'stat') throw new Error('gone');
        if (message.type === 'update') return { state: 'available', latest: { build: 'b2' } };
        return null;
      },
      on: (event, listener) => {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      },
    },
  };
  const shell = connectShell(host)!;
  // The update events reach the page's listener until it unsubscribes.
  const steps: unknown[] = [];
  const off = shell.on('update', (detail) => steps.push(detail));
  listeners.get('update')!({ state: 'available' });
  off();
  assert.equal(listeners.has('update'), false);
  assert.deepEqual(steps, [{ state: 'available' }]);
  assert.deepEqual(await shell.request({ type: 'update' }), { state: 'available', latest: { build: 'b2' } });
  assert.equal(await shell.pickPath({ type: 'open' }), '/p/a.py');
  assert.equal(await shell.pickPath({ type: 'saveAs', name: 'b.py' }), null);
  assert.equal(await shell.request({ type: 'stat', path: '/p/a.py' }), null);
  shell.notify({ type: 'status', state: 'ready' });
  // Cells' runs completed: the autosave notice, with the cells' numbers.
  reportCellRun(shell, [4]);
  reportCellRun(shell, [1, 2, 3]);
  reportCellRun(shell, []);
  // A run that raised: the record's message says so, as the history view
  // parses it (claerbout history.js: `cell run [n] (error)`).
  reportCellRun(shell, [2, 3], true);
  reportCellRun(shell, [], true);
  assert.deepEqual(
    sent.map((message) => message.type),
    ['update', 'open', 'saveAs', 'stat', 'status', 'autosave', 'autosave', 'autosave'],
  );
  assert.deepEqual(sent.at(-3), { type: 'autosave', trigger: 'cell run [4]' });
  assert.deepEqual(sent.at(-2), { type: 'autosave', trigger: 'cell run [1, 2, 3]' });
  assert.deepEqual(sent.at(-1), { type: 'autosave', trigger: 'cell run [2, 3] (error)' });
}

// A rewind in the history view: `save` answered with `saved` and the same
// id, `reload` re-reading only a document whose path it names.
{
  const sent: ShellMessage[] = [];
  const listeners = new Map<string, (detail: unknown) => void>();
  const shell = connectShell({
    claerbout: {
      request: async (message) => {
        sent.push(message);
        return null;
      },
      on: (event, listener) => {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      },
    },
  })!;
  const calls: string[] = [];
  let saveAnswer: () => Promise<string | null> = async () => null;
  let path: string | null = '/private/tmp/week-3/fit.py';
  const page: RewindPage = {
    path: () => path,
    save: () => {
      calls.push('save');
      return saveAnswer();
    },
    release: () => void calls.push('release'),
    reload: async (rewound) => void calls.push(`reload: ${rewound}`),
  };
  const off = answerRewinds(shell, page);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const fire = async (event: string, detail: unknown) => {
    listeners.get(event)!(detail);
    await settle();
  };

  // Saved (nothing unsaved, or written): ok, with the event's id.
  await fire('save', { id: 'a1', reason: 'rewind' });
  assert.deepEqual(sent.at(-1), { type: 'saved', id: 'a1', ok: true });
  // Could not write: ok: false and why, which refuses the rewind.
  saveAnswer = async () => 'fit.py is not saved to a file yet';
  await fire('save', { id: 'a2', reason: 'rewind' });
  assert.deepEqual(sent.at(-1), { type: 'saved', id: 'a2', ok: false, error: 'fit.py is not saved to a file yet' });
  // A save that throws is still answered, never left to the 3 s wait.
  saveAnswer = async () => {
    throw new Error('disk full');
  };
  await fire('save', { id: 'a3', reason: 'rewind' });
  assert.deepEqual(sent.at(-1), { type: 'saved', id: 'a3', ok: false, error: 'disk full' });
  // No id, nothing to answer: not even saved.
  const before = sent.length;
  await fire('save', { reason: 'rewind' });
  assert.equal(sent.length, before);
  assert.deepEqual(calls, ['save', 'save', 'save']);
  calls.length = 0;

  // A reload that names this document re-reads it; git's /private/tmp is
  // the /tmp the page was given, and the other way round.
  const to = '1a2b3c4d5e6f708192a3b4c5d6e7f80912a3b4c5';
  await fire('reload', { id: 'r1', paths: ['/tmp/week-3/data.csv', '/tmp/week-3/fit.py'], reason: 'rewind', to });
  path = '/tmp/week-3/fit.py';
  await fire('reload', { id: 'r2', paths: ['/private/tmp/week-3/fit.py'], reason: 'rewind', to, app: 'plass' });
  // One that does not name it only ends the save's hold, and nothing of
  // it is answered: the shell waits for no answer to reload.
  await fire('reload', { id: 'r3', paths: ['/tmp/week-3/fit.py.bak', '/tmp/week-3/other/fit.py'], reason: 'rewind', to });
  await fire('reload', { id: 'r4', paths: 'not a list', reason: 'rewind', to });
  path = null;
  await fire('reload', { id: 'r5', paths: ['/tmp/week-3/fit.py'], reason: 'rewind', to });
  assert.deepEqual(calls, [
    'reload: Rewound to 1a2b3c4',
    'reload: Rewound by Plass to 1a2b3c4',
    'release',
    'release',
    'release',
  ]);
  assert.equal(sent.length, before);

  off();
  assert.equal(listeners.size, 0);
}

// Paths, notes and the history request's answers.
assert.equal(samePath('/tmp/a.py', '/tmp/a.py'), true);
assert.equal(samePath('/private/tmp/a.py', '/tmp/a.py'), true);
assert.equal(samePath('/var/folders/x/a.py', '/private/var/folders/x/a.py'), true);
assert.equal(samePath('/private/tmpx/a.py', '/tmpx/a.py'), false);
assert.equal(samePath('/Users/t/Projects/a.py', '/Users/t/Projects/b.py'), false);
assert.equal(samePath('/Users/t/caf\u00e9/a.py', '/Users/t/cafe\u0301/a.py'), true);
assert.equal(rewindNote('1a2b3c4d5e6f'), 'Rewound to 1a2b3c4');
assert.equal(rewindNote('1a2b3c4d5e6f', 'knuth'), 'Rewound to 1a2b3c4');
assert.equal(rewindNote('1a2b3c4d5e6f', 'maniml'), 'Rewound by Maniml to 1a2b3c4');
assert.equal(rewindNote(undefined), 'Rewound');
assert.equal(historyNote({ opened: true }), null);
assert.equal(historyNote({ reason: 'unsaved' }), 'No history yet: save the document in a folder of its own, and the record begins');
assert.equal(historyNote({ reason: 'refused', detail: 'a temporary folder is never recorded' }), 'No history here: a temporary folder is never recorded');
assert.equal(historyNote({ reason: 'refused' }), 'No history here: its folder is not one the record keeps');
assert.equal(historyNote({ reason: 'off' }), 'No history: the autosave record is off');
assert.equal(historyNote({ reason: 'no-git' }), 'No history: the record is kept with git, and this Mac has none');
assert.equal(historyNote(null), 'This Knuth.app has no history view: a newer shell brings it');

// Without a shell the notice goes nowhere, and nothing throws.
reportCellRun(null, [1]);

console.log('shell: ok');
