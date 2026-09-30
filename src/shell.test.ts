// connectShell against fake hosts: the Claerbout bridge, and a plain tab
// without one.
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
}

console.log('shell: ok');
