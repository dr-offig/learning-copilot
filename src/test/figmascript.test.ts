import * as assert from 'assert';

import {
	DELIVERY_MODES,
	PROBE_SENTINEL,
	SENTINEL,
	buildExtractorScript,
	buildProbeScript,
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
		// A failure is now named in the report, so the next silent empty list
		// is diagnosable from the cached JSON instead of a metered probe.
		assert.ok(walk.includes('summary.frameError'));
	});

	test('an unsupported loadAllPagesAsync cannot abort the frame walk', () => {
		const script = buildExtractorScript('throw');
		const walk = script.slice(script.indexOf('const frames = []'), script.indexOf('const isArtboard'));

		// Measured: inside use_figma the property exists but calling it throws
		// '"loadAllPagesAsync" is not a supported API'. A typeof guard passes,
		// the call throws, and the outer catch used to discard every frame.
		assert.ok(walk.includes('loadAllPagesAsync'));
		assert.ok(
			(walk.match(/try\s*\{/g) ?? []).length >= 2,
			'the optional page-load call needs its own catch, not just the outer one'
		);
	});
});

suite('figma layout capture', () => {
	test('layouts are opt-in, so the working token import cannot start truncating', () => {
		const withoutLayouts = buildExtractorScript('throw');
		const withLayouts = buildExtractorScript('throw', { includeLayouts: true });

		assert.ok(!withoutLayouts.includes('const describe ='), 'default must not walk the tree');
		assert.ok(withLayouts.includes('const describe ='));
		assert.ok(withLayouts.length > withoutLayouts.length);
		// Both still declare `layouts`, so the report shape does not change.
		assert.ok(withoutLayouts.includes('const layouts = []'));
	});

	test('the layout placeholder is always substituted', () => {
		for (const opts of [{}, { includeLayouts: true }]) {
			const script = buildExtractorScript('throw', opts);
			assert.ok(!script.includes('LAYOUT_BLOCK'), `placeholder left in for ${JSON.stringify(opts)}`);
		}
	});

	test('both variants parse as valid JavaScript', () => {
		for (const opts of [{}, { includeLayouts: true }]) {
			assert.doesNotThrow(
				() => new Function('figma', `return (async () => {${buildExtractorScript('throw', opts)}})()`),
				`should parse with ${JSON.stringify(opts)}`
			);
		}
	});

	test('the walk is bounded, because the payload rides back in an error string', () => {
		const script = buildExtractorScript('throw', { includeLayouts: true });

		assert.ok(script.includes('let budget = 400'));
		assert.ok(script.includes('depth > 8'));
		assert.ok(script.includes('summary.layoutTruncated'));
		// Decorative geometry would multiply the node count for no benefit.
		assert.ok(script.includes('VECTOR:'));
		// A component instance repeats its whole internal tree per use.
		assert.ok(/n\.type === 'INSTANCE'.*return d;/s.test(script));
	});

	test('the payload channel cap is respected by shedding artboards, not by truncating', () => {
		const script = buildExtractorScript('throw', { includeLayouts: true });

		// Measured against the real server: the error string carrying the
		// payload is cut at about 20KB, and a cut payload is worth nothing —
		// the whole metered call is wasted. Dropping whole artboards keeps the
		// JSON valid and says how much went.
		assert.ok(script.includes('JSON.stringify(result).length > 18000'));
		assert.ok(script.includes('layouts.pop()'));
		assert.ok(script.includes('summary.layoutsDropped'));
	});

	test('tokens can be left out when only layouts are wanted', () => {
		const withTokens = buildExtractorScript('throw', { includeLayouts: true });
		const withoutTokens = buildExtractorScript('throw', { includeLayouts: true, includeTokens: false });

		assert.ok(withTokens.includes('const includeTokens = true'));
		assert.ok(withoutTokens.includes('const includeTokens = false'));
		// The variables are still read either way: the layout walk needs their
		// names to report which token is bound where.
		assert.ok(withoutTokens.includes('getLocalVariableCollectionsAsync'));
		assert.ok(withoutTokens.includes('varNames[v.id] = v.name'));
		assert.ok(withoutTokens.includes('if (includeTokens) {'));
	});

	test('artboards can be selected by name', () => {
		const all = buildExtractorScript('throw', { includeLayouts: true });
		const one = buildExtractorScript('throw', { includeLayouts: true, layoutNames: ['Desktop'] });

		assert.ok(all.includes('const wantedLayouts = null'));
		assert.ok(one.includes('const wantedLayouts = ["Desktop"]'));
		assert.ok(one.includes('wantedLayouts.indexOf(a.node.name) < 0'));
	});

	test('text nodes do not repeat their own content as a name', () => {
		const script = buildExtractorScript('throw', { includeLayouts: true });

		// Figma names a text layer after its content; the duplication was ~9%
		// of a payload that has no room to spare.
		assert.ok(script.includes("d.text.indexOf(d.name) === 0"));
		assert.ok(script.includes('delete d.name'));
	});

	test('a layout failure is recorded, not swallowed', () => {
		const script = buildExtractorScript('throw', { includeLayouts: true });

		assert.ok(script.includes('summary.layoutError'));
		assert.ok(script.includes('layouts.length = 0'));
	});

	test('tokens are resolved by name from the maps the token walk already built', () => {
		const script = buildExtractorScript('throw', { includeLayouts: true });

		// Reusing these costs no extra API calls, and naming the token is what
		// makes the outline more useful than a screenshot.
		assert.ok(script.includes('varNames[v.id] = v.name'));
		assert.ok(script.includes('styleNames[s.id] = s.name'));
		assert.ok(script.includes('varNames[entry.id]'));
		assert.ok(script.includes('styleNames[n.textStyleId]'));
	});
});

suite('figma api probe', () => {
	test('it parses as valid JavaScript', () => {
		assert.doesNotThrow(() => new Function('figma', `return (async () => {${buildProbeScript()}})()`));
	});

	test('it reports failures instead of swallowing them', () => {
		const script = buildProbeScript();

		// The extractor's frame walk hid its own error behind a catch that
		// emptied the list; the whole point of the probe is not to do that.
		for (const step of ['loadAllPagesAsync:', 'figma.root.children:', 'figma.currentPage:']) {
			assert.ok(script.includes(`'${step} '`), `should record a failure of ${step}`);
		}
		assert.ok(script.includes('out.errors.push'));
		// Each step is caught separately, so one restricted call cannot mask
		// the results of the others.
		assert.ok((script.match(/catch \(e\)/g) ?? []).length >= 4);
	});

	test('it probes the API surface the richer plans would need', () => {
		const script = buildProbeScript();

		for (const key of ['hasRoot', 'hasCurrentPage', 'hasLoadAllPages', 'pageCount', 'childCount']) {
			assert.ok(script.includes(key), `should report ${key}`);
		}
	});

	test('its output cannot be mistaken for a token report', () => {
		assert.notStrictEqual(PROBE_SENTINEL, SENTINEL);
		assert.ok(buildProbeScript().includes(JSON.stringify(PROBE_SENTINEL)));
		assert.ok(!buildProbeScript().includes(JSON.stringify(SENTINEL)));

		// A probe result fed to the report reader is rejected, not half-read.
		const probeOutput = `Error: ${PROBE_SENTINEL}{"api":{"pageCount":2},"pages":[],"errors":[]}`;
		assert.ok(!readExtractorResult(probeOutput).ok);
	});

	test('its payload is capped so the diagnostic cannot itself truncate', () => {
		const script = buildProbeScript();

		assert.ok(script.includes('pages.slice(0, 20)'));
		assert.ok(script.includes('kids.slice(0, 5)'));
		assert.ok(script.includes('.slice(0, 40)'), 'layer names should be trimmed');
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
