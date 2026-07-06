import * as assert from 'assert';

import {
	applyMasksToContent,
	answerKeyHasAnswerFor,
	assembleAnswerKeyMd,
	extractComprehensionQuestionIds,
	extractRegionEditableText,
	getExpectedMarkerLineRegexForPath,
	listTaskRegions,
	resolveSnippetInContent,
	resolveTaskSelections,
	sanitizeTaskId,
	validateScaffoldPlan,
} from '../masking';
import type { ScaffoldPlan, TaskSelection } from '../types';

const JS_FILE = [
	'function add(a, b) {',
	'  return a + b;',
	'}',
	'',
	'function clamp(value, min, max) {',
	'  if (value < min) { return min; }',
	'  if (value > max) { return max; }',
	'  return value;',
	'}',
	'',
].join('\n');

suite('resolveSnippetInContent', () => {
	test('finds a unique exact snippet', () => {
		const res = resolveSnippetInContent(JS_FILE, '  if (value < min) { return min; }\n  if (value > max) { return max; }');
		assert.strictEqual(res.status, 'ok');
		if (res.status === 'ok') {
			assert.strictEqual(res.firstLine, 5);
			assert.strictEqual(res.lastLine, 6);
			assert.ok(res.solutionText.includes('return min;'));
		}
	});

	test('falls back to whitespace-trimmed matching when the model re-indents', () => {
		const res = resolveSnippetInContent(JS_FILE, 'if (value < min) { return min; }');
		assert.strictEqual(res.status, 'ok');
		if (res.status === 'ok') {
			// The solution is taken from the real file, indentation intact.
			assert.strictEqual(res.solutionText, '  if (value < min) { return min; }');
		}
	});

	test('reports ambiguity when the snippet occurs twice', () => {
		const content = 'let x = 1;\nlet x = 1;\n';
		const res = resolveSnippetInContent(content, 'let x = 1;');
		assert.strictEqual(res.status, 'ambiguous');
	});

	test('uses preferRanges to disambiguate repeated snippets', () => {
		const content = 'let x = 1;\nlet y = 2;\nlet x = 1;\n';
		const res = resolveSnippetInContent(content, 'let x = 1;', [{ startLine: 3, endLine: 3 }]);
		assert.strictEqual(res.status, 'ok');
		if (res.status === 'ok') {
			assert.strictEqual(res.firstLine, 2);
		}
	});

	test('reports not-found for absent snippets', () => {
		assert.strictEqual(resolveSnippetInContent(JS_FILE, 'nothing like this').status, 'not-found');
	});
});

suite('resolveTaskSelections', () => {
	const files = new Map([['app.js', JS_FILE]]);

	function sel(partial: Partial<TaskSelection>): TaskSelection {
		return {
			id: 'clamp-low',
			path: 'app.js',
			targetSnippet: '  if (value < min) { return min; }',
			placeholder: '',
			...partial,
		};
	}

	test('accepts a valid selection', () => {
		const { masksByFile, failures } = resolveTaskSelections(files, [sel({})]);
		assert.strictEqual(failures.length, 0);
		assert.strictEqual(masksByFile.get('app.js')?.length, 1);
	});

	test('rejects duplicate ids', () => {
		const { failures } = resolveTaskSelections(files, [
			sel({}),
			sel({ targetSnippet: '  return a + b;' }),
		]);
		assert.strictEqual(failures.length, 1);
		assert.match(failures[0].reason, /Duplicate task id/);
	});

	test('rejects snippets outside changedRanges', () => {
		const changed = new Map([['app.js', [{ startLine: 1, endLine: 3 }]]]);
		const { failures, masksByFile } = resolveTaskSelections(files, [sel({})], changed);
		assert.strictEqual(masksByFile.get('app.js')?.length ?? 0, 0);
		assert.strictEqual(failures.length, 1);
		assert.match(failures[0].reason, /outside the changed ranges/);
	});

	test('drops overlapping regions and reports them', () => {
		const { failures, masksByFile } = resolveTaskSelections(files, [
			sel({ id: 'a', targetSnippet: '  if (value < min) { return min; }\n  if (value > max) { return max; }' }),
			sel({ id: 'b', targetSnippet: '  if (value > max) { return max; }\n  return value;' }),
		]);
		assert.strictEqual(masksByFile.get('app.js')?.length, 1);
		assert.strictEqual(failures.length, 1);
		assert.match(failures[0].reason, /overlaps/);
	});

	test('rejects files not in the input set', () => {
		const { failures } = resolveTaskSelections(files, [sel({ path: 'other.js' })]);
		assert.match(failures[0].reason, /not one of the provided input files/);
	});
});

suite('applyMasksToContent', () => {
	function maskFirst(content: string, path: string, snippet: string, placeholder = '') {
		const { masksByFile, failures } = resolveTaskSelections(
			new Map([[path, content]]),
			[{ id: 'demo', path, targetSnippet: snippet, placeholder }]
		);
		assert.strictEqual(failures.length, 0, JSON.stringify(failures));
		return applyMasksToContent(path, content, masksByFile.get(path)!);
	}

	test('inserts JS line-comment markers with matching indentation', () => {
		const { maskedContent, tasks } = maskFirst(JS_FILE, 'app.js', '  if (value < min) { return min; }');
		const lines = maskedContent.split('\n');
		const startIdx = lines.findIndex((l) => l.includes('__LC_TASK_demo_START__'));
		assert.ok(startIdx >= 0);
		assert.strictEqual(lines[startIdx], '  // __LC_TASK_demo_START__');
		assert.ok(getExpectedMarkerLineRegexForPath('app.js', 'START').test(lines[startIdx]));
		assert.strictEqual(tasks[0].solution, '  if (value < min) { return min; }');
		// Placeholder was empty, so a fallback prompt comment is inserted.
		assert.ok(lines[startIdx + 1].includes('Task demo'));
	});

	test('uses python comment markers for .py files', () => {
		const py = 'def f(x):\n    return x * 2\n';
		const { maskedContent } = maskFirst(py, 'main.py', '    return x * 2');
		const lines = maskedContent.split('\n');
		const startLine = lines.find((l) => l.includes('_START__'))!;
		assert.ok(getExpectedMarkerLineRegexForPath('main.py', 'START').test(startLine));
		assert.ok(startLine.trimStart().startsWith('#'));
	});

	test('uses CSS block-comment markers for .css files', () => {
		const css = 'body {\n  color: red;\n}\n';
		const { maskedContent } = maskFirst(css, 'style.css', '  color: red;');
		const startLine = maskedContent.split('\n').find((l) => l.includes('_START__'))!;
		assert.ok(getExpectedMarkerLineRegexForPath('style.css', 'START').test(startLine));
	});

	test('uses JS comments inside <script> blocks of HTML files', () => {
		const html = [
			'<html><body>',
			'<script>',
			'  const n = 42;',
			'</script>',
			'</body></html>',
		].join('\n');
		const { maskedContent } = maskFirst(html, 'index.html', '  const n = 42;');
		const startLine = maskedContent.split('\n').find((l) => l.includes('_START__'))!;
		assert.ok(startLine.includes('// __LC_TASK_demo_START__'), `got: ${startLine}`);
	});

	test('uses HTML comments in HTML markup', () => {
		const html = '<html><body>\n  <button id="go">Go</button>\n</body></html>';
		const { maskedContent } = maskFirst(html, 'index.html', '  <button id="go">Go</button>');
		const startLine = maskedContent.split('\n').find((l) => l.includes('_START__'))!;
		assert.ok(startLine.includes('<!-- __LC_TASK_demo_START__ -->'), `got: ${startLine}`);
	});

	test('replaces a placeholder equivalent to the solution with the fallback comment', () => {
		const { maskedContent } = maskFirst(
			JS_FILE,
			'app.js',
			'  if (value < min) { return min; }',
			'if (value < min)  {  return min; }'
		);
		const regions = listTaskRegions(maskedContent);
		const editable = extractRegionEditableText(maskedContent, regions[0]);
		assert.ok(editable.includes('Task demo'), `placeholder should be the fallback, got: ${editable}`);
	});

	test('re-indents flush-left placeholders to the region indentation', () => {
		const { maskedContent } = maskFirst(
			JS_FILE,
			'app.js',
			'  if (value < min) { return min; }',
			'if (value < ???) { return ???; }'
		);
		const lines = maskedContent.split('\n');
		const placeholderLine = lines.find((l) => l.includes('???'))!;
		assert.ok(placeholderLine.startsWith('  '), `expected indentation, got: ${JSON.stringify(placeholderLine)}`);
	});

	test('applies multiple masks bottom-up without corrupting other regions', () => {
		const { masksByFile, failures } = resolveTaskSelections(
			new Map([['app.js', JS_FILE]]),
			[
				{ id: 'add', path: 'app.js', targetSnippet: '  return a + b;', placeholder: 'return 0;' },
				{ id: 'clamp', path: 'app.js', targetSnippet: '  return value;', placeholder: '' },
			]
		);
		assert.strictEqual(failures.length, 0);
		const { maskedContent, tasks } = applyMasksToContent('app.js', JS_FILE, masksByFile.get('app.js')!);
		const regions = listTaskRegions(maskedContent);
		assert.deepStrictEqual(regions.map((r) => r.id), ['add', 'clamp']);
		assert.deepStrictEqual(tasks.map((t) => t.id), ['add', 'clamp']);
		assert.strictEqual(tasks[0].solution, '  return a + b;');
		assert.strictEqual(tasks[1].solution, '  return value;');
	});

	test('preserves CRLF line endings', () => {
		const crlf = JS_FILE.replace(/\n/g, '\r\n');
		const { masksByFile } = resolveTaskSelections(
			new Map([['app.js', crlf]]),
			[{ id: 'demo', path: 'app.js', targetSnippet: '  return a + b;', placeholder: '' }]
		);
		const { maskedContent } = applyMasksToContent('app.js', crlf, masksByFile.get('app.js')!);
		assert.ok(maskedContent.includes('\r\n'));
	});
});

suite('scaffold plan round trip', () => {
	test('a deterministically masked plan passes validateScaffoldPlan with no issues', () => {
		const { masksByFile, failures } = resolveTaskSelections(
			new Map([['app.js', JS_FILE]]),
			[
				{ id: 'add', path: 'app.js', targetSnippet: '  return a + b;', placeholder: 'return b;', hint: 'Add them.', explanation: 'Adds the numbers.' },
				{ id: 'clampLow', path: 'app.js', targetSnippet: '  if (value < min) { return min; }', placeholder: '', hint: 'Lower bound.', explanation: 'Clamps below.' },
			]
		);
		assert.strictEqual(failures.length, 0);
		const { maskedContent, tasks } = applyMasksToContent('app.js', JS_FILE, masksByFile.get('app.js')!);

		const exercisesMd = '# Exercises\n\n## Comprehension Questions\n- [CQ1] What does add do?\n- [CQ2] What does clamp do?\n';
		const answerKeyMd = assembleAnswerKeyMd(tasks, '## Comprehension Answers\n[CQ1] Adds.\n[CQ2] Clamps.\n');

		const plan: ScaffoldPlan = {
			maskedFiles: [{ path: 'app.js', content: maskedContent }],
			tasks,
			exercisesMd,
			answerKeyMd,
		};

		const issues = validateScaffoldPlan(plan);
		assert.deepStrictEqual(issues, [], JSON.stringify(issues, null, 2));
	});
});

suite('answer key assembly', () => {
	test('contains every solution and comprehension answer tag', () => {
		const key = assembleAnswerKeyMd(
			[{ id: 'add', path: 'app.js', solution: 'return a + b;', hint: 'h', explanation: 'e' }],
			'## Comprehension Answers\n[CQ1] Because.\n'
		);
		assert.ok(key.includes('return a + b;'));
		assert.ok(key.includes('**Hint:** h'));
		assert.ok(answerKeyHasAnswerFor('CQ1', key));
	});

	test('extractComprehensionQuestionIds sorts numerically', () => {
		assert.deepStrictEqual(
			extractComprehensionQuestionIds('[CQ10] ten [CQ2] two [CQ1] one'),
			['CQ1', 'CQ2', 'CQ10']
		);
	});
});

suite('sanitizeTaskId', () => {
	test('normalizes whitespace and strips invalid characters', () => {
		assert.strictEqual(sanitizeTaskId(' validate input '), 'validate-input');
		assert.strictEqual(sanitizeTaskId('ok_id-3'), 'ok_id-3');
		assert.strictEqual(sanitizeTaskId('***'), null);
		assert.strictEqual(sanitizeTaskId(42 as unknown as string), null);
	});
});
