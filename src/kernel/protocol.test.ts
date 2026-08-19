// Every ServerEvent variant, accepted and refused. The Playwright harness
// only exercises a few event types end-to-end; this pins the validation
// layer itself, so a server-side reshape of any event fails a test instead
// of shipping.
import assert from 'node:assert/strict';
import { parseServerEvent } from './protocol.ts';

const ok = (event: unknown) =>
  assert.deepEqual(parseServerEvent(event), event, `accepted: ${JSON.stringify(event)}`);
const bad = (event: unknown) =>
  assert.equal(parseServerEvent(event), null, `refused: ${JSON.stringify(event)}`);

// Not an event at all.
bad(null);
bad(undefined);
bad('ready');
bad(42);
bad([]);
bad({});
bad({ type: 42 });
bad({ type: 'no_such_event' });

// attached: protocol + session + resumed, all required.
ok({ type: 'attached', protocol: 2, session: 'abc', resumed: false });
bad({ type: 'attached', protocol: '2', session: 'abc', resumed: false });
bad({ type: 'attached', protocol: 2, session: 'abc' });

// incompatible: numeric protocol required.
ok({ type: 'incompatible', protocol: 3 });
bad({ type: 'incompatible', protocol: 'v3' });

// ready: resumed and id both optional but typed.
ok({ type: 'ready' });
ok({ type: 'ready', resumed: true, id: 7 });
bad({ type: 'ready', resumed: 'yes' });
bad({ type: 'ready', id: -1 });

// Request ids are non-negative safe integers everywhere.
bad({ type: 'stream', id: 1.5, which: 'stdout', text: 'x' });
bad({ type: 'stream', id: -3, which: 'stdout', text: 'x' });

// stream: which is exactly stdout/stderr.
ok({ type: 'stream', id: 1, which: 'stderr', text: 'boom' });
bad({ type: 'stream', id: 1, which: 'stdin', text: 'boom' });
bad({ type: 'stream', id: 1, which: 'stdout' });

// figures: two string arrays.
ok({ type: 'figures', id: 2, svgs: ['<svg/>'], named: [] });
bad({ type: 'figures', id: 2, svgs: ['<svg/>', 7], named: [] });
bad({ type: 'figures', id: 2, svgs: ['<svg/>'] });

// done: result is a string or null, never absent.
ok({ type: 'done', id: 3, result: null });
ok({ type: 'done', id: 3, result: "'42'" });
bad({ type: 'done', id: 3 });
bad({ type: 'done', id: 3, result: 42 });

// error: traceback required.
ok({ type: 'error', id: 4, traceback: 'Traceback...' });
bad({ type: 'error', id: 4 });

// namespace: every var fully shaped; optional fields typed when present.
ok({ type: 'namespace', id: 5, vars: [] });
ok({
  type: 'namespace',
  id: 5,
  vars: [{ name: 'df', type: 'DataFrame', shape: [3, 2], preview: '...', figure: false }],
});
bad({ type: 'namespace', id: 5, vars: [{ name: 'x', type: 'int' }] });
bad({ type: 'namespace', id: 5, vars: [{ name: 'x', type: 'int', preview: '1', shape: ['3'] }] });
bad({ type: 'namespace', id: 5, vars: [{ name: 'x', type: 'int', preview: '1', scratch: 1 }] });
bad({ type: 'namespace', id: 5, vars: {} });

// artifacts: values is a record, figures maps names to SVG strings.
ok({ type: 'artifacts', id: 6, values: { x: 1 }, figures: { fig: '<svg/>' } });
bad({ type: 'artifacts', id: 6, values: [], figures: {} });
bad({ type: 'artifacts', id: 6, values: {}, figures: { fig: 7 } });

// table: name required; the window fields optional but typed.
ok({ type: 'table', id: 7, name: 'df' });
ok({
  type: 'table', id: 7, name: 'df',
  columns: ['a'], index: ['0'], rows: [['1']], total_rows: 1, total_cols: 1, offset: 0,
});
ok({ type: 'table', id: 7, name: 'df', error: 'not a table' });
bad({ type: 'table', id: 7 });
bad({ type: 'table', id: 7, name: 'df', rows: [['1'], 'oops'] });
bad({ type: 'table', id: 7, name: 'df', total_rows: -1 });

// figure: name required; svg/error optional strings.
ok({ type: 'figure', id: 8, name: 'fig', svg: '<svg/>' });
ok({ type: 'figure', id: 8, name: 'fig', error: 'no such figure' });
bad({ type: 'figure', id: 8, svg: '<svg/>' });
bad({ type: 'figure', id: 8, name: 'fig', svg: 7 });

// protocol_error / kernel_exit: error required, correlation optional.
ok({ type: 'protocol_error', error: 'bad request', request: 'table', id: 9 });
ok({ type: 'protocol_error', error: 'bad frame' });
bad({ type: 'protocol_error', request: 'table' });
ok({ type: 'kernel_exit', error: 'died', returncode: -9 });
bad({ type: 'kernel_exit', returncode: -9 });

// server_busy / kernel_start_failed: just an explanation.
ok({ type: 'server_busy', error: 'at capacity' });
ok({ type: 'kernel_start_failed', error: 'no python' });
bad({ type: 'server_busy' });
bad({ type: 'kernel_start_failed', error: 7 });

console.log('protocol.test: all assertions passed');
