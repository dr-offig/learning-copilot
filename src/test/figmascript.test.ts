import * as assert from 'assert';

import {
	DELIVERY_MODES,
	SENTINEL,
	buildExtractorScript,
	readExtractorResult,
} from '../figmascript';

const REPORT = {
	summary: { totalCollections: 1, totalVariables: 1, aliasModeValues: 0, literalModeValues: 1, textStyles: 0 },
	collections: [
		{
			collection: 'Primitive Colours',
			modes: ['Mode 1'],
			variables: [
				{ name: 'Purple/100', resolvedType: 'COLOR', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: '#F1EBFF' }] },
			],
		},
	],
};

const PAYLOAD = SENTINEL + JSON.stringify(REPORT);

suite('figma extractor script', () => {
	test('both delivery modes share one body and differ only in the tail', () => {
		const returned = buildExtractorScript('return');
		const thrown = buildExtractorScript('throw');

		assert.ok(returned.includes('getLocalVariableCollectionsAsync'));
		assert.ok(thrown.includes('getLocalVariableCollectionsAsync'));
		assert.ok(returned.trimEnd().endsWith('__lcPayload;'));
		assert.ok(thrown.trimEnd().endsWith('throw new Error(__lcPayload);'));

		// Everything up to the payload line is shared by definition; only the
		// delivery tail after it may differ.
		const bodyOf = (s: string) => s.slice(0, s.indexOf('const __lcPayload'));
		assert.ok(bodyOf(returned).length > 0);
		assert.strictEqual(bodyOf(returned), bodyOf(thrown), 'the extraction logic must not diverge between modes');
	});

	test('throw is attempted first, because use_figma discards return values', () => {
		// Measured against the remote Figma MCP server: the returning variant
		// answers "Code executed with no return value.". Trying it first would
		// cost every new user a wasted metered call and an extra confirmation
		// prompt, so the working mode leads and the other stays as a fallback.
		assert.deepStrictEqual([...DELIVERY_MODES], ['throw', 'return']);
	});

	test('the sentinel placeholder is substituted, not left in the script', () => {
		for (const mode of DELIVERY_MODES) {
			const script = buildExtractorScript(mode);
			assert.ok(!script.includes('SENTINEL_LITERAL'), `${mode}: placeholder still present`);
			assert.ok(script.includes(JSON.stringify(SENTINEL)), `${mode}: sentinel literal missing`);
		}
	});

	test('the script is syntactically valid inside an async function', () => {
		for (const mode of DELIVERY_MODES) {
			assert.doesNotThrow(
				() => new Function('figma', `return (async () => {${buildExtractorScript(mode)}})()`),
				`${mode} variant should parse`
			);
		}
	});

	test('it captures every variable type, not just colours', () => {
		const script = buildExtractorScript('return');
		// A resolvedType filter here would silently drop whole collections.
		assert.ok(!/resolvedType\s*!==\s*'COLOR'/.test(script));
		assert.ok(script.includes("resolvedType === 'FLOAT'"));
		assert.ok(script.includes('getLocalTextStylesAsync'));
	});

	test('the script leads with an explanation, since the approval dialog shows it raw', () => {
		for (const mode of DELIVERY_MODES) {
			const script = buildExtractorScript(mode);
			const head = script.slice(0, 800);

			assert.ok(head.includes('Learning Copilot'), `${mode}: should say whose script this is`);
			assert.ok(/DOES NOT CHANGE YOUR DESIGN/i.test(head), `${mode}: should say it is read-only`);
			// The deliberate throw is the single most alarming thing a reader
			// hits, so it has to be explained before they reach it.
			assert.ok(/THROWING AN ERROR ON PURPOSE/i.test(head), `${mode}: should explain the throw`);
			assert.ok(head.indexOf('Learning Copilot') < script.indexOf('async function'));
		}
	});

	test('frame capture is guarded so it can never cost us the variables', () => {
		const script = buildExtractorScript('throw');

		assert.ok(script.includes('frames'), 'frames should be captured');
		// Newer plugin API versions require this before reaching other pages.
		assert.ok(script.includes('loadAllPagesAsync'));
		// The whole frame walk sits in a try/catch that empties the list, so a
		// failure there degrades to "no breakpoint suggestions" rather than
		// losing an extraction the student paid a metered call for.
		const walk = script.slice(script.indexOf('const frames = []'));
		assert.ok(/try\s*\{/.test(walk));
		assert.ok(walk.includes('frames.length = 0'));
		// Capped, because the payload rides back inside an error message.
		assert.ok(walk.includes('frames.length >= 200'));
	});
});

suite('figma extractor result reading', () => {
	test('reads a plainly returned payload', () => {
		const result = readExtractorResult(PAYLOAD);

		assert.ok(result.ok, result.ok ? '' : result.reason);
		assert.strictEqual(result.report.collections[0].collection, 'Primitive Colours');
	});

	test('reads a payload thrown as an Error, stack trace and all', () => {
		const text = [
			`Error: ${PAYLOAD}`,
			'    at extractFigmaTokens (PLUGIN_5_SOURCE:67:18)',
			'',
			'Figma Debug UUID: bddb0a24-e152-4f1d-9640-5977f13e52d7',
		].join('\n');

		const result = readExtractorResult(text);

		assert.ok(result.ok, result.ok ? '' : result.reason);
		assert.strictEqual(result.report.collections[0].variables[0].name, 'Purple/100');
	});

	test('reads a payload buried in agent commentary and a markdown fence', () => {
		const text = [
			'I ran the script. It threw deliberately, as designed. Here is the output:',
			'',
			'```',
			`Error: ${PAYLOAD}`,
			'```',
			'',
			'Let me know if you want me to summarise the tokens.',
		].join('\n');

		assert.ok(readExtractorResult(text).ok);
	});

	test('braces inside string values do not end the payload early', () => {
		const tricky = {
			collections: [
				{
					collection: 'C',
					modes: ['M'],
					variables: [
						{ name: 'Odd}Name{', resolvedType: 'STRING', valuesByMode: [{ mode: 'M', kind: 'literal', value: 'a"b}c' }] },
					],
				},
			],
		};
		const result = readExtractorResult(`Error: ${SENTINEL}${JSON.stringify(tricky)}\n    at x (y:1:1)`);

		assert.ok(result.ok, result.ok ? '' : result.reason);
		assert.strictEqual(result.report.collections[0].variables[0].name, 'Odd}Name{');
	});

	test('the last payload wins when the transcript contains an earlier attempt', () => {
		const older = { collections: [{ collection: 'Stale', modes: ['M'], variables: [] }] };
		const text = `${SENTINEL}${JSON.stringify(older)}\n...retrying...\n${PAYLOAD}`;

		const result = readExtractorResult(text);

		assert.ok(result.ok, result.ok ? '' : result.reason);
		assert.strictEqual(result.report.collections[0].collection, 'Primitive Colours');
	});

	test('a result with no payload is reported, not guessed at', () => {
		const result = readExtractorResult('Successfully executed code in the Figma file.');

		assert.ok(!result.ok);
		assert.ok(result.reason.includes('No token report found'));
	});

	test('a truncated payload is reported as truncated, with the size seen', () => {
		const result = readExtractorResult(`${SENTINEL}{"collections": [{"collection": "C"`);

		assert.ok(!result.ok);
		assert.ok(result.reason.includes('cut off'));
		// The length distinguishes "Figma changed" from "this file is too big".
		assert.ok(/\d+ characters received/.test(result.reason), result.reason);
	});

	test('a payload that is valid JSON but not a report is rejected', () => {
		const result = readExtractorResult(`${SENTINEL}{"unrelated": true}`);

		assert.ok(!result.ok);
		assert.ok(result.reason.includes("no 'collections' array"));
	});

	test('a JSON object unrelated to us is ignored without the sentinel', () => {
		// The response may legitimately contain other JSON; only the sentinel
		// marks our payload.
		const result = readExtractorResult('{"collections": [{"collection":"Decoy","modes":[],"variables":[]}]}');

		assert.ok(!result.ok);
	});
});
