import * as assert from 'assert';

import {
	buildTaskJumpLinks,
	buildTaskLinkUri,
	getCompletedTaskKeySet,
	getTaskStateKey,
	listMarkedTaskKeys,
	prependTaskLinksSection,
	refreshTaskLinksSection,
} from '../tasklinks';
import type { ScaffoldPlan, ScaffoldTask } from '../types';

const MASKED_APP_JS = [
	'function add(a, b) {',
	'  // __LC_TASK_sum_START__',
	'  return 0; // TODO',
	'  // __LC_TASK_sum_END__',
	'}',
	'',
].join('\n');

function makePlan(): ScaffoldPlan {
	return {
		maskedFiles: [{ path: 'scripts/app.js', content: MASKED_APP_JS }],
		tasks: [{ id: 'sum', path: 'scripts/app.js', solution: '  return a + b;' }],
		exercisesMd: '# Exercises\n\nDo the thing.\n',
	};
}

/** Extracts the `path` query parameter of every task link in a document. */
function linkPaths(markdown: string): string[] {
	return [...markdown.matchAll(/openTaskLink\?([^)]+)\)/g)].map(
		(m) => new URLSearchParams(m[1]).get('path') ?? ''
	);
}

suite('task links', () => {
	test('generated links are workspace-relative, not absolute', () => {
		const links = buildTaskJumpLinks(makePlan());

		assert.strictEqual(links.length, 1);
		assert.strictEqual(links[0].rel, 'scripts/app.js');
		assert.strictEqual(new URL(links[0].uri).searchParams.get('path'), 'scripts/app.js');
		assert.ok(!links[0].uri.includes('%2F' + 'Users'), 'link must not embed an absolute path');
	});

	test('a document written with absolute links is repaired in place', () => {
		const absolute =
			'<!-- LC_TASK_LINKS_START -->\n' +
			'# Task Links\n' +
			'\n' +
			'- [ ] **sum**: [scripts/app.js:2](vscode://dr-offig.learning-copilot/openTaskLink' +
			'?path=%2FUsers%2Fsomeone%2FOriginal%2Fscripts%2Fapp.js&line=2)' +
			' <!-- LC_TASK_LINK|scripts/app.js|sum -->\n' +
			'\n' +
			'<!-- LC_TASK_LINKS_END -->\n';

		const repaired = refreshTaskLinksSection(absolute, new Set());

		assert.deepStrictEqual(linkPaths(repaired), ['scripts/app.js']);
		assert.ok(!repaired.includes('Original'), 'the original folder must be gone from the link');
		// The line number and completion state survive the rewrite.
		assert.ok(repaired.includes('[scripts/app.js:2]'));
		assert.ok(repaired.includes('- [ ] **sum**'));
		assert.ok(repaired.includes('<!-- LC_TASK_LINK|scripts/app.js|sum -->'));
	});

	test('rewriting is idempotent', () => {
		const md = prependTaskLinksSection(makePlan().exercisesMd, buildTaskJumpLinks(makePlan()), []);
		const once = refreshTaskLinksSection(md, new Set());
		assert.strictEqual(once, md);
		assert.strictEqual(refreshTaskLinksSection(once, new Set()), once);
	});

	test('completed tasks are ticked and incomplete ones cleared', () => {
		const plan = makePlan();
		const md = prependTaskLinksSection(plan.exercisesMd, buildTaskJumpLinks(plan), []);
		assert.ok(md.includes('- [ ] **sum**'));

		const done: ScaffoldTask[] = [{ ...plan.tasks[0], completed: true }];
		const ticked = refreshTaskLinksSection(md, getCompletedTaskKeySet(done));
		assert.ok(ticked.includes('- [x] **sum**'));

		const untickedAgain = refreshTaskLinksSection(ticked, new Set());
		assert.ok(untickedAgain.includes('- [ ] **sum**'));
	});

	test('link markers identify the tasks a document belongs to', () => {
		const plan = makePlan();
		const md = prependTaskLinksSection(plan.exercisesMd, buildTaskJumpLinks(plan), []);

		assert.deepStrictEqual([...listMarkedTaskKeys(md)], [getTaskStateKey('scripts/app.js', 'sum')]);
		assert.deepStrictEqual([...listMarkedTaskKeys('no markers here')], []);
	});

	test('paths needing escaping survive a round trip', () => {
		const rel = 'src/my components/a b.js';
		const uri = buildTaskLinkUri(rel, 7);

		const params = new URLSearchParams(uri.split('?')[1]);
		assert.strictEqual(params.get('path'), rel);
		assert.strictEqual(params.get('line'), '7');
	});
});
