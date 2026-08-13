// Milestone 2 dev panel: prove the Kernel interface end to end from the
// browser (run, live streams, tracebacks, interrupt, restart, namespace).
// The real document UI replaces this in Milestone 3.

import { SidecarKernel, DEFAULT_KERNEL_URL, type NamespaceVar } from './kernel/kernel.ts';

const app = document.getElementById('app')!;
app.innerHTML = `
  <style>
    body { font: 14px/1.5 ui-monospace, monospace; margin: 2rem auto; max-width: 44rem; padding: 0 1rem; }
    textarea { width: 100%; height: 9rem; font: inherit; box-sizing: border-box; }
    button { font: inherit; margin-right: 0.5rem; }
    pre { background: #f5f5f5; padding: 0.75rem; white-space: pre-wrap; min-height: 2rem; }
    pre.err { color: #b00020; }
    #status { color: #666; margin-bottom: 0.75rem; }
    #ns { color: #666; }
  </style>
  <div id="status">connecting to ${DEFAULT_KERNEL_URL} — start with: .venv/bin/knuth serve</div>
  <textarea id="code">import time
for i in range(5):
    print('tick', i)
    time.sleep(0.5)
6 * 7</textarea>
  <p>
    <button id="run">Run</button>
    <button id="stop">Stop</button>
    <button id="restart">Restart</button>
  </p>
  <pre id="out"></pre>
  <pre id="result"></pre>
  <div id="ns"></div>
`;

const $ = (id: string) => document.getElementById(id)!;
const code = $('code') as HTMLTextAreaElement;
const out = $('out');
const result = $('result');

const kernel = new SidecarKernel();
kernel.ready.then(
  () => ($('status').textContent = 'kernel ready'),
  (e) => ($('status').textContent = String(e)),
);

function showNamespace(vars: NamespaceVar[]): void {
  $('ns').textContent =
    'namespace: ' +
    (vars.map((v) => `${v.name}: ${v.type} = ${v.preview}`).join(' · ') || '(empty)');
}

$('run').addEventListener('click', async () => {
  out.textContent = '';
  result.textContent = '';
  result.className = '';
  const outcome = await kernel.run(code.value, {
    onStream: (which, text) => {
      out.textContent += which === 'stderr' ? `[stderr] ${text}` : text;
    },
  });
  if (outcome.ok) {
    result.textContent = outcome.result ?? '';
  } else {
    result.textContent = outcome.traceback ?? '';
    result.className = 'err';
  }
  showNamespace(await kernel.namespace());
});

$('stop').addEventListener('click', () => kernel.interrupt());
$('restart').addEventListener('click', async () => {
  await kernel.restart();
  $('status').textContent = 'kernel ready (restarted)';
  showNamespace(await kernel.namespace());
});
