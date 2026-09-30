// connectShell against fake hosts: the Claerbout bridge, the Swift shell's
// WebKit handler, and a plain tab with neither.
import assert from 'node:assert/strict';
import { connectShell, type ShellHost, type ShellMessage } from './shell.ts';

// A plain tab: no shell.
assert.equal(connectShell({}), null);

// The Claerbout bridge: requests are promises; a rejected one reads as no
// answer, the way a missing shell does.
{
  const sent: ShellMessage[] = [];
  const host: ShellHost = {
    claerbout: {
      request: async (message) => {
        sent.push(message);
        if (message.type === 'open') return { path: '/p/a.py' };
        if (message.type === 'saveAs') return { path: null };
        if (message.type === 'stat') throw new Error('gone');
        return null;
      },
      on: () => () => {},
    },
  };
  const shell = connectShell(host)!;
  assert.equal(await shell.pickPath({ type: 'open' }), '/p/a.py');
  assert.equal(await shell.pickPath({ type: 'saveAs', name: 'b.py' }), null);
  assert.equal(await shell.request({ type: 'stat', path: '/p/a.py' }), null);
  shell.notify({ type: 'status', state: 'ready' });
  assert.deepEqual(
    sent.map((message) => message.type),
    ['open', 'saveAs', 'stat', 'status'],
  );
  // The bridge wins when both are present: no WebKit reply hook is installed.
  assert.equal(host.knuthShell, undefined);
}

// The Swift shell: ids out, window.knuthShell.reply(id, result) back, in
// any order; notices carry no id, since only an id gets an answer.
{
  const posted: (ShellMessage & { id?: number })[] = [];
  const host: ShellHost = {
    webkit: { messageHandlers: { knuth: { postMessage: (message) => posted.push(message) } } },
  };
  const shell = connectShell(host)!;
  const read = shell.request<{ text: string }>({ type: 'read', path: '/p/a.py' });
  const picked = shell.pickPath({ type: 'open' });
  shell.notify({ type: 'error', message: 'boom' });
  assert.deepEqual(
    posted.map((message) => [message.type, message.id]),
    [
      ['read', 1],
      ['open', 2],
      ['error', undefined],
    ],
  );
  host.knuthShell!.reply(2, { path: '/p/b.py' });
  host.knuthShell!.reply(1, { text: 'x = 1\n' });
  assert.equal(await picked, '/p/b.py');
  assert.deepEqual(await read, { text: 'x = 1\n' });
}

console.log('shell: ok');
