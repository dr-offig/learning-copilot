import * as assert from 'assert';

import { generateScaffoldPlanDeterministic } from '../scaffold';
import { listTaskRegions, validateScaffoldPlan } from '../masking';
import type { LlmJsonClient, LlmJsonRequest } from '../types';

const APP_JS = [
	'function add(a, b) {',
	'  return a + b;',
	'}',
	'',
	'function greet(name) {',
	'  return `Hello, ${name}!`;',
	'}',
	'',
].join('\n');

const QUIET_LOG = { appendLine: (_line: string) => { /* silent */ } };

/** Scripted fake client: responds per schemaName, recording every request. */
class FakeClient implements LlmJsonClient {
	readonly id = 'vscode-lm' as const;
	readonly label = 'fake';
	readonly calls: LlmJsonRequest[] = [];

	constructor(private readonly script: Record<string, Array<unknown | Error>>) {}

	async requestJson(req: LlmJsonRequest): Promise<unknown> {
		this.calls.push(req);
		const queue = this.script[req.schemaName];
		if (!queue || queue.length === 0) {
			throw new Error(`FakeClient has no scripted response for ${req.schemaName}`);
		}
		const next = queue.shift()!;
		if (next instanceof Error) { throw next; }
		return next;
	}
}

const GOOD_EXERCISES = {
	exercisesMd: [
		'# Exercises',
		'Intro.',
		'## Tasks',
		'- Task add in app.js',
		'## Comprehension Questions',
		'- [CQ1] q1', '- [CQ2] q2', '- [CQ3] q3', '- [CQ4] q4', '- [CQ5] q5',
	].join('\n'),
	comprehensionAnswersMd: '## Comprehension Answers\n[CQ1] a\n[CQ2] a\n[CQ3] a\n[CQ4] a\n[CQ5] a\n',
};

suite('generateScaffoldPlanDeterministic', () => {
	test('produces a valid plan from good selections', async () => {
		const client = new FakeClient({
			emit_task_selection: [{
				tasks: [
					{ id: 'add', path: 'app.js', targetSnippet: '  return a + b;', placeholder: 'return 0;', hint: 'sum', explanation: 'adds' },
					{ id: 'greet', path: 'app.js', targetSnippet: '  return `Hello, ${name}!`;', placeholder: '', hint: 'template', explanation: 'greets' },
				],
			}],
			emit_exercises: [GOOD_EXERCISES],
		});

		const plan = await generateScaffoldPlanDeterministic({
			files: [{ rel: 'app.js', content: APP_JS }],
			briefMd: 'A tiny demo app.',
			client,
			log: QUIET_LOG,
			report: () => {},
		});

		assert.strictEqual(plan.tasks.length, 2);
		assert.strictEqual(plan.maskedFiles.length, 1);
		const regions = listTaskRegions(plan.maskedFiles[0].content);
		assert.deepStrictEqual(regions.map((r) => r.id), ['add', 'greet']);
		assert.ok(plan.answerKeyMd!.includes('[CQ1]'));
		assert.deepStrictEqual(validateScaffoldPlan(plan), []);
		// One selection call + one exercises call, no repairs.
		assert.strictEqual(client.calls.length, 2);
	});

	test('retries only the failed selections, then succeeds', async () => {
		const client = new FakeClient({
			emit_task_selection: [
				{
					tasks: [
						{ id: 'add', path: 'app.js', targetSnippet: '  return a + b;', placeholder: '', hint: '', explanation: '' },
						{ id: 'bogus', path: 'app.js', targetSnippet: 'this text is not in the file', placeholder: '', hint: '', explanation: '' },
					],
				},
				{
					tasks: [
						{ id: 'bogus', path: 'app.js', targetSnippet: '  return `Hello, ${name}!`;', placeholder: '', hint: '', explanation: '' },
					],
				},
			],
			emit_exercises: [GOOD_EXERCISES],
		});

		const plan = await generateScaffoldPlanDeterministic({
			files: [{ rel: 'app.js', content: APP_JS }],
			briefMd: '',
			client,
			log: QUIET_LOG,
			report: () => {},
		});

		assert.strictEqual(plan.tasks.length, 2);
		const repairCall = client.calls[1];
		assert.strictEqual(repairCall.traceLabel, 'Task selection repair');
		assert.match(repairCall.instructions, /bogus/);
		assert.ok(!repairCall.instructions.includes("id 'add'"), 'repair prompt should not list the successful task as failed');
		assert.deepStrictEqual(validateScaffoldPlan(plan), []);
	});

	test('respects changedRanges for focused scaffolds', async () => {
		const client = new FakeClient({
			emit_task_selection: [
				{
					tasks: [
						// Outside the changed range → dropped.
						{ id: 'add', path: 'app.js', targetSnippet: '  return a + b;', placeholder: '', hint: '', explanation: '' },
						// Inside the changed range → kept.
						{ id: 'greet', path: 'app.js', targetSnippet: '  return `Hello, ${name}!`;', placeholder: '', hint: '', explanation: '' },
					],
				},
				// Repair pass for the dropped selection returns nothing usable.
				{ tasks: [] },
			],
			emit_exercises: [GOOD_EXERCISES],
		});

		const plan = await generateScaffoldPlanDeterministic({
			files: [{ rel: 'app.js', content: APP_JS, changedRanges: [{ startLine: 5, endLine: 7 }] }],
			briefMd: '',
			client,
			log: QUIET_LOG,
			report: () => {},
		});

		assert.deepStrictEqual(plan.tasks.map((t) => t.id), ['greet']);
	});

	test('falls back to a deterministic exercise sheet when the exercises call fails', async () => {
		const client = new FakeClient({
			emit_task_selection: [{
				tasks: [
					{ id: 'add', path: 'app.js', targetSnippet: '  return a + b;', placeholder: '', hint: 'sum things', explanation: '' },
				],
			}],
			emit_exercises: [new Error('model unavailable'), new Error('model unavailable')],
		});

		const plan = await generateScaffoldPlanDeterministic({
			files: [{ rel: 'app.js', content: APP_JS }],
			briefMd: 'Brief text.',
			client,
			log: QUIET_LOG,
			report: () => {},
		});

		assert.ok(plan.exercisesMd.includes('# Learning Exercises'));
		assert.ok(plan.exercisesMd.includes('sum things'));
		assert.ok(plan.answerKeyMd!.includes('No comprehension answers'));
	});

	test('throws when no selection can be resolved at all', async () => {
		const client = new FakeClient({
			emit_task_selection: [
				{ tasks: [{ id: 'x', path: 'app.js', targetSnippet: 'not present', placeholder: '', hint: '', explanation: '' }] },
				{ tasks: [] },
			],
			emit_exercises: [GOOD_EXERCISES],
		});

		await assert.rejects(
			generateScaffoldPlanDeterministic({
				files: [{ rel: 'app.js', content: APP_JS }],
				briefMd: '',
				client,
				log: QUIET_LOG,
				report: () => {},
			}),
			/No usable task regions/
		);
	});

	test('repairs exercises once when CQ tags are missing', async () => {
		const badExercises = {
			exercisesMd: '# Exercises\nNo questions here.',
			comprehensionAnswersMd: '',
		};
		const client = new FakeClient({
			emit_task_selection: [{
				tasks: [
					{ id: 'add', path: 'app.js', targetSnippet: '  return a + b;', placeholder: '', hint: '', explanation: '' },
				],
			}],
			emit_exercises: [badExercises, GOOD_EXERCISES],
		});

		const plan = await generateScaffoldPlanDeterministic({
			files: [{ rel: 'app.js', content: APP_JS }],
			briefMd: '',
			client,
			log: QUIET_LOG,
			report: () => {},
		});

		assert.ok(plan.exercisesMd.includes('[CQ1]'));
		const exerciseCalls = client.calls.filter((c) => c.schemaName === 'emit_exercises');
		assert.strictEqual(exerciseCalls.length, 2);
		assert.match(exerciseCalls[1].instructions, /previous response had these problems/);
	});
});
