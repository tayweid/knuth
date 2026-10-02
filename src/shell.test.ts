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
  assert.deepEqual(
    sent.map((message) => message.type),
    ['update', 'open', 'saveAs', 'stat', 'status'],
  );
}

console.log('shell: ok');
