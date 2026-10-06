// connectShell against fake hosts: the Claerbout bridge, and a plain tab
// without one.
import assert from 'node:assert/strict';
import {
  answerRewinds,
  connectShell,
  historyNote,
  inlineHistory,
  reportCellRun,
  rewindNote,
  samePath,
  unsavedReporter,
  type Box,
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
    saveForClose: (choose) => {
      calls.push(`close ${choose}`);
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

  // A close's save (reason 'close'): saveForClose, never the rewind's
  // save and its hold; `choose` only when the close dialog's Save asked
  // for it (anything but true is a quiet write).
  saveAnswer = async () => null;
  await fire('save', { id: 'c1', reason: 'close', choose: false });
  assert.deepEqual(sent.at(-1), { type: 'saved', id: 'c1', ok: true });
  saveAnswer = async () => 'fit.py is not saved to a file yet';
  await fire('save', { id: 'c2', reason: 'close' });
  assert.deepEqual(sent.at(-1), { type: 'saved', id: 'c2', ok: false, error: 'fit.py is not saved to a file yet' });
  await fire('save', { id: 'c3', reason: 'close', choose: 'yes' });
  saveAnswer = async () => null;
  await fire('save', { id: 'c4', reason: 'close', choose: true });
  assert.deepEqual(sent.at(-1), { type: 'saved', id: 'c4', ok: true });
  saveAnswer = async () => {
    throw new Error('the save panel failed');
  };
  await fire('save', { id: 'c5', reason: 'close', choose: true });
  assert.deepEqual(sent.at(-1), { type: 'saved', id: 'c5', ok: false, error: 'the save panel failed' });
  // Any reason but 'close' is a rewind's, as before there were closes.
  saveAnswer = async () => null;
  await fire('save', { id: 'r0', reason: 'other', choose: true });
  assert.deepEqual(sent.at(-1), { type: 'saved', id: 'r0', ok: true });
  assert.deepEqual(calls, ['close false', 'close false', 'close false', 'close true', 'close true', 'save']);
  calls.length = 0;
  const answered = sent.length;

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
  assert.equal(sent.length, answered);

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

// The History view in the room (inlineHistory): `open` with the room's
// box, `close` while it is up; pressed only by the shell's word; `bounds`
// once a frame while it is up, for a box that changed; `toggle` from View ›
// History… does what the tile does.
{
  const sent: ShellMessage[] = [];
  const listeners = new Map<string, (detail: unknown) => void>();
  let answer: unknown = { opened: true, inline: true };
  const shell = connectShell({
    claerbout: {
      request: async (message) => {
        sent.push(message);
        return message.action === 'open' ? answer : message.action === 'close' ? { closed: true } : { ok: true };
      },
      on: (event, listener) => {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      },
    },
  })!;
  let box: Box = { x: 44, y: 44, width: 1048, height: 708 };
  let ratio = 2;
  const painted: boolean[] = [];
  const answers: unknown[] = [];
  const frames: Array<() => void> = [];
  const view = inlineHistory(shell, {
    room: () => box,
    paint: (shown) => painted.push(shown),
    answered: (reply) => answers.push(reply),
    ratio: () => ratio,
    frame: (run) => frames.push(run),
  });
  const fire = (detail: unknown) => listeners.get('history')!(detail);
  const flush = () => frames.splice(0).forEach((run) => run());

  await view.toggle();
  assert.deepEqual(sent, [{ type: 'history', action: 'open', inline: { x: 44, y: 44, width: 1048, height: 708 } }]);
  assert.deepEqual(answers, [{ opened: true, inline: true }]);
  // Not pressed by the click: only by the shell's word.
  assert.equal(view.shown, false);
  assert.deepEqual(painted, []);
  view.moved();
  assert.equal(frames.length, 0);
  fire({ kind: 'inline', state: 'open' });
  assert.equal(view.shown, true);
  assert.deepEqual(painted, [true]);
  // The room unchanged since the open: no bounds.
  assert.equal(sent.length, 1);

  // Moved: coalesced to a frame, the last box sent; the same box again,
  // nothing; a zoom step (another ratio), sent again.
  box = { x: 44, y: 44, width: 1100, height: 708 };
  view.moved();
  box = { x: 44, y: 44, width: 1136, height: 760 };
  view.moved();
  assert.equal(frames.length, 1);
  flush();
  assert.deepEqual(sent.slice(1), [{ type: 'history', action: 'bounds', inline: { x: 44, y: 44, width: 1136, height: 760 } }]);
  view.moved();
  flush();
  assert.equal(sent.length, 2);
  ratio = 2.4;
  view.moved();
  flush();
  assert.equal(sent.length, 3);
  assert.equal(sent[2].action, 'bounds');

  // Again: close; closed by the shell's word (Escape in the view, too).
  await view.toggle();
  assert.deepEqual(sent[3], { type: 'history', action: 'close' });
  assert.equal(view.shown, true);
  fire({ kind: 'inline', state: 'closed' });
  assert.equal(view.shown, false);
  assert.deepEqual(painted, [true, false]);
  view.moved();
  assert.equal(frames.length, 0);
  view.close();
  assert.equal(sent.length, 4);

  // View › History…: the page's own toggle, with its room's box; the room
  // moved between the open and the view: placed when it comes.
  fire({ kind: 'toggle' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent[4], { type: 'history', action: 'open', inline: { x: 44, y: 44, width: 1136, height: 760 } });
  box = { x: 44, y: 44, width: 1124, height: 760 };
  fire({ kind: 'inline', state: 'open' });
  assert.deepEqual(sent[5], { type: 'history', action: 'bounds', inline: { x: 44, y: 44, width: 1124, height: 760 } });
  view.close();
  assert.deepEqual(sent[6], { type: 'history', action: 'close' });
  // Other history events are not the page's to act on.
  fire({ kind: 'commit' });
  fire(null);
  assert.equal(sent.length, 7);
  fire({ kind: 'inline', state: 'closed' });

  // No view (an older shell's null, a reason): the answer is the page's to say.
  answer = null;
  await view.toggle();
  assert.equal(answers.at(-1), null);
  assert.equal(view.shown, false);
  view.dispose();
  assert.equal(listeners.has('history'), false);
}

// The close guard's report (unsavedReporter): `unsaved` with the page's
// state, sent only when it changed; the first waits for the shell's
// answer, and the latest state follows it.
{
  const sent: ShellMessage[] = [];
  let answer: (reply: unknown) => void = () => undefined;
  const shell = connectShell({
    claerbout: {
      request: (message) => {
        sent.push(message);
        return message.type === 'unsaved' ? new Promise((resolve) => (answer = resolve)) : Promise.resolve(null);
      },
      on: () => () => undefined,
    },
  })!;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const reporter = unsavedReporter(shell);
  assert.equal(reporter.guarded, null);
  // Once after load: a new document, nothing to lose.
  reporter.report({ unsaved: false, name: 'Knuth.py', save: 'choose' });
  assert.deepEqual(sent, [{ type: 'unsaved', unsaved: false, name: 'Knuth.py', save: 'choose' }]);
  // While the answer is on its way, nothing more is sent; only the latest
  // state is kept for after it.
  reporter.report({ unsaved: true, name: 'Knuth.py', save: 'choose' });
  reporter.report({ unsaved: true, name: 'fit.py', save: 'quiet' });
  assert.equal(sent.length, 1);
  answer({ guarded: true });
  await settle();
  assert.equal(reporter.guarded, true);
  assert.deepEqual(sent.at(-1), { type: 'unsaved', unsaved: true, name: 'fit.py', save: 'quiet' });
  assert.equal(sent.length, 2);
  // The same state again (every keystroke reports): nothing sent.
  reporter.report({ unsaved: true, name: 'fit.py', save: 'quiet' });
  assert.equal(sent.length, 2);
  // Guarded: each change goes at once, without waiting for its answer.
  reporter.report({ unsaved: false, name: 'fit.py', save: 'quiet' });
  reporter.report({ unsaved: true, name: 'fit.py', save: 'quiet' });
  assert.deepEqual(
    sent.slice(2).map((message) => message.unsaved),
    [false, true],
  );
  // A label and a detail ride along only when the page has them.
  reporter.report({ unsaved: true, name: 'fit.py', save: 'choose', label: 'Save to a Folder…', detail: 'fit.py was moved.' });
  assert.deepEqual(sent.at(-1), {
    type: 'unsaved',
    unsaved: true,
    name: 'fit.py',
    save: 'choose',
    label: 'Save to a Folder…',
    detail: 'fit.py was moved.',
  });
  // The first answer the same as what was sent: no second report.
  const quiet = unsavedReporter(shell);
  quiet.report({ unsaved: false, name: 'Knuth.py', save: 'choose' });
  const count = sent.length;
  answer({ guarded: true });
  await settle();
  assert.equal(sent.length, count);
}

// An older shell answers null (it has no close guard): the page stops
// telling it, whatever changes after.
{
  const sent: ShellMessage[] = [];
  const shell = connectShell({
    claerbout: {
      request: async (message) => {
        sent.push(message);
        return null;
      },
      on: () => () => undefined,
    },
  })!;
  const reporter = unsavedReporter(shell);
  reporter.report({ unsaved: false, name: 'Knuth.py', save: 'choose' });
  reporter.report({ unsaved: true, name: 'Knuth.py', save: 'choose' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reporter.guarded, false);
  reporter.report({ unsaved: true, name: 'fit.py', save: 'quiet' });
  reporter.report({ unsaved: false, name: 'fit.py', save: 'quiet' });
  assert.deepEqual(sent, [{ type: 'unsaved', unsaved: false, name: 'Knuth.py', save: 'choose' }]);
  // A bridge that fails reads as no answer, the same.
  const failing = unsavedReporter(
    connectShell({
      claerbout: {
        request: async () => {
          throw new Error('no handler');
        },
        on: () => () => undefined,
      },
    }),
  );
  failing.report({ unsaved: true, name: 'Knuth.py', save: 'choose' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(failing.guarded, false);
}

// Without a shell the notice goes nowhere, and nothing throws.
reportCellRun(null, [1]);
const tab = unsavedReporter(null);
tab.report({ unsaved: true, name: 'Knuth.py', save: 'choose' });
assert.equal(tab.guarded, false);

console.log('shell: ok');
