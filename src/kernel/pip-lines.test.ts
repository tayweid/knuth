import assert from 'node:assert/strict';
import { pipDirectives } from './pip-lines.ts';

assert.deepEqual(pipDirectives('# %pip install seaborn'), ['seaborn']);
assert.deepEqual(pipDirectives('#!pip install -q seaborn plotly==5.0'), ['seaborn', 'plotly==5.0']);
assert.deepEqual(pipDirectives('  # % pip install a\nimport a\n# !pip install a b'), ['a', 'b']);
// Live magics are not Python and never reach a kernel; only the commented
// form counts. Prose mentioning pip does not either.
assert.deepEqual(pipDirectives('%pip install seaborn'), []);
assert.deepEqual(pipDirectives('# run pip install seaborn first'), []);
assert.deepEqual(pipDirectives('x = 1'), []);
console.log('pip-lines.test: all assertions passed');
