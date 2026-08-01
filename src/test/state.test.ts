import * as assert from 'assert';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	emptyScaffoldState,
	getLatestAnswerKeyPath,
	getStateFilePath,
	hasSolutionSnapshot,
	hasStateFile,
	parseScaffoldState,
	readFigmaReport,
	readScaffoldState,
	readScaffoldStateSync,
	readSolutionFile,
	writeAnswerKey,
	writeFigmaReport,
	writeScaffoldState,
	writeSolutionSnapshot,
	STATE_DIR_NAME,
} from '../state';
import type { ScaffoldTask } from '../types';

const TASKS: ScaffoldTask[] = [
	{ id: 'sum', path: 'scripts/app.js', solution: '  return a + b;', hint: 'add them' },
	{ id: 'greet', path: 'scripts/app.js', solution: '  return `Hi ${name}`;', completed: true },
];

async function makeWorkspace(): Promise<string> {
	return await fsp.mkdtemp(path.join(os.tmpdir(), 'lc-state-'));
}

suite('workspace state', () => {
	const roots: string[] = [];

	async function newRoot(): Promise<string> {
		const root = await makeWorkspace();
		roots.push(root);
		return root;
	}

	suiteTeardown(async () => {
		for (const root of roots) {
			await fsp.rm(root, { recursive: true, force: true });
		}
	});

	test('state round-trips through the workspace folder', async () => {
		const root = await newRoot();
		assert.strictEqual(hasStateFile(root), false);

		await writeScaffoldState(root, {
			...emptyScaffoldState(),
			tasks: TASKS,
			imageRoles: { 'designs/home.png': 'design' },
			designAnalyses: { 'designs/home.png': { hash: 'abc', analyzedAt: 'now', analysisMd: '# Home' } },
		});

		assert.ok(hasStateFile(root));
		assert.ok(getStateFilePath(root).endsWith(path.join(STATE_DIR_NAME, 'state.json')));

		const loaded = await readScaffoldState(root);
		assert.deepStrictEqual(loaded.tasks, TASKS);
		assert.strictEqual(loaded.imageRoles['designs/home.png'], 'design');
		assert.strictEqual(loaded.designAnalyses['designs/home.png'].analysisMd, '# Home');
		assert.deepStrictEqual(readScaffoldStateSync(root), loaded);
	});

	test('state survives being copied to another folder', async () => {
		const root = await newRoot();
		await writeScaffoldState(root, { ...emptyScaffoldState(), tasks: TASKS });
		await writeSolutionSnapshot(root, [{ rel: 'scripts/app.js', fullContent: 'solved\n' }]);
		await writeAnswerKey(root, '# Answers\n');

		const copy = await newRoot();
		await fsp.cp(root, copy, { recursive: true });

		assert.deepStrictEqual((await readScaffoldState(copy)).tasks, TASKS);
		assert.strictEqual(readSolutionFile(copy, 'scripts/app.js'), 'solved\n');
		assert.ok(getLatestAnswerKeyPath(copy)?.startsWith(copy));
	});

	test('a missing or corrupt state file degrades to empty state', async () => {
		const root = await newRoot();
		assert.deepStrictEqual(await readScaffoldState(root), emptyScaffoldState());

		await fsp.mkdir(path.join(root, STATE_DIR_NAME), { recursive: true });
		await fsp.writeFile(getStateFilePath(root), '{ not json', 'utf8');
		assert.deepStrictEqual(await readScaffoldState(root), emptyScaffoldState());

		// Entries missing required fields are dropped, valid siblings kept.
		const partial = parseScaffoldState(
			JSON.stringify({ tasks: [{ id: 'ok', path: 'a.js', solution: 'x' }, { id: 'bad' }] })
		);
		assert.strictEqual(partial.tasks.length, 1);
		assert.strictEqual(partial.tasks[0].id, 'ok');
	});

	test('figma import choices survive a save/load round trip', async () => {
		const root = await newRoot();
		const figma = {
			fileKey: 'CNwr0twjwrQOY5hTMtu0IH',
			extractedAt: '2026-08-01T06:02:07.360Z',
			deliveryMode: 'throw' as const,
			baseModes: { 'Semantic Colours': 'Light', 'Font Sizes and Spacing': 'Desktop' },
			modeConditions: {
				'Font Sizes and Spacing::Tablet': { kind: 'media' as const, query: '(max-width: 64rem)' },
				'Font Sizes and Spacing::Phone': { kind: 'media' as const, query: '(max-width: 40rem)' },
			},
		};

		await writeScaffoldState(root, { ...emptyScaffoldState(), figma });
		const loaded = await readScaffoldState(root);

		assert.deepStrictEqual(loaded.figma, figma);
		// Order matters: it decides which override block wins on a phone.
		assert.deepStrictEqual(Object.keys(loaded.figma.modeConditions!), [
			'Font Sizes and Spacing::Tablet',
			'Font Sizes and Spacing::Phone',
		]);
	});

	test('a state file written before figma support still loads', () => {
		const legacy = parseScaffoldState(JSON.stringify({ tasks: [], imageRoles: {}, designAnalyses: {} }));

		assert.deepStrictEqual(legacy.figma, {});
	});

	test('nonsense in the figma block is dropped rather than trusted', () => {
		const state = parseScaffoldState(
			JSON.stringify({
				figma: {
					fileKey: 42,
					deliveryMode: 'telepathy',
					baseModes: { Good: 'Light', Bad: 7 },
					modeConditions: {
						Keep: { kind: 'media', query: '(max-width: 40rem)' },
						NoQuery: { kind: 'media' },
						Unknown: { kind: 'wat' },
					},
				},
			})
		);

		assert.strictEqual(state.figma.fileKey, undefined);
		assert.strictEqual(state.figma.deliveryMode, undefined);
		assert.deepStrictEqual(state.figma.baseModes, { Good: 'Light' });
		assert.deepStrictEqual(Object.keys(state.figma.modeConditions!), ['Keep']);
	});

	test('the extracted figma report is cached beside the rest of the state', async () => {
		const root = await newRoot();
		assert.strictEqual(await readFigmaReport(root), null);

		const report = { collections: [{ collection: 'C', modes: ['M'], variables: [] }] };
		const target = await writeFigmaReport(root, report);

		assert.ok(target.startsWith(path.join(root, STATE_DIR_NAME)));
		assert.deepStrictEqual(await readFigmaReport(root), report);
		// No leftover temp file from the atomic write.
		assert.ok(!fs.existsSync(`${target}.tmp`));
	});

	test('snapshots merge rather than replace across runs', async () => {
		const root = await newRoot();
		assert.strictEqual(hasSolutionSnapshot(root), false);

		await writeSolutionSnapshot(root, [
			{ rel: 'a.js', fullContent: 'first\n' },
			{ rel: 'nested/b.js', fullContent: 'nested\n' },
		]);
		// A later run touches only one of the files.
		await writeSolutionSnapshot(root, [{ rel: 'a.js', fullContent: 'second\n' }]);

		assert.ok(hasSolutionSnapshot(root));
		assert.strictEqual(readSolutionFile(root, 'a.js'), 'second\n');
		assert.strictEqual(readSolutionFile(root, 'nested/b.js'), 'nested\n');
		assert.strictEqual(readSolutionFile(root, 'never-written.js'), null);
	});

	test('snapshot reads cannot escape the solutions folder', async () => {
		const root = await newRoot();
		await writeSolutionSnapshot(root, [{ rel: 'a.js', fullContent: 'ok\n' }]);
		const secret = path.join(root, 'secret.txt');
		await fsp.writeFile(secret, 'private\n', 'utf8');

		assert.strictEqual(readSolutionFile(root, '../../secret.txt'), null);
		assert.strictEqual(readSolutionFile(root, secret), null);
	});

	test('only the newest answer keys are kept, newest resolves last', async () => {
		const root = await newRoot();
		assert.strictEqual(getLatestAnswerKeyPath(root), null);

		const written: string[] = [];
		for (let i = 0; i < 7; i++) {
			written.push(await writeAnswerKey(root, `# Key ${i}\n`));
			// Keys are timestamped to the millisecond; keep them distinct.
			await new Promise((resolve) => setTimeout(resolve, 5));
		}

		const dir = path.dirname(written[0]);
		assert.strictEqual(fs.readdirSync(dir).length, 5);

		const latest = getLatestAnswerKeyPath(root);
		assert.strictEqual(latest, written[written.length - 1]);
		assert.strictEqual(fs.readFileSync(latest!, 'utf8'), '# Key 6\n');
	});
});
