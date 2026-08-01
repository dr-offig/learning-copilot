import * as assert from 'assert';

import {
	applyBaseModes,
	emitTokensCss,
	findFrameCandidatesForMode,
	orderModeConditions,
	parseFigmaTokenReport,
	toKebabCase,
} from '../figmatokens';
import type { FigmaTokenReport, ModeCondition } from '../figmatokens';

/**
 * The real report extracted from a student design file via the Figma Plugin
 * API, trimmed to the variables the assertions below need. Counts in
 * `summary` are the extractor's own, and are deliberately left at the
 * full-file values in `REAL_SUMMARY_COUNTS` so the cross-check can be tested
 * both ways.
 */
function makeReport(): FigmaTokenReport {
	return {
		collections: [
			{
				collection: 'Primitive Colours',
				modes: ['Mode 1'],
				variables: [
					{ name: 'Purple/200', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: '#E0E0F0' }] },
					{ name: 'Purple/500', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: '#A2A1C1' }] },
					{ name: 'Purple/600', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: '#9785A0' }] },
					{ name: 'Purple/700', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: '#797596' }] },
					{ name: 'Purple/800', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: '#8379A0' }] },
					{ name: 'Neutral/0', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: '#FFFFFF' }] },
					{ name: 'Neutral/100', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: '#F8F5F1' }] },
					{ name: 'Neutral/700', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: '#444240' }] },
					{ name: 'Neutral/900', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: '#171513' }] },
				],
			},
			{
				collection: 'Semantic Colours',
				modes: ['Light', 'Dark'],
				variables: [
					{
						name: 'Background',
						valuesByMode: [
							{ mode: 'Light', kind: 'alias', aliasTarget: 'Neutral/100' },
							{ mode: 'Dark', kind: 'alias', aliasTarget: 'Neutral/700' },
						],
					},
					{
						name: 'Surface',
						valuesByMode: [
							{ mode: 'Light', kind: 'alias', aliasTarget: 'Purple/600' },
							{ mode: 'Dark', kind: 'alias', aliasTarget: 'Purple/600' },
						],
					},
					{
						name: 'Primary',
						valuesByMode: [
							{ mode: 'Light', kind: 'alias', aliasTarget: 'Purple/700' },
							{ mode: 'Dark', kind: 'alias', aliasTarget: 'Purple/500' },
						],
					},
					{
						name: 'Highlight on Primary',
						valuesByMode: [
							{ mode: 'Light', kind: 'alias', aliasTarget: 'Neutral/0' },
							{ mode: 'Dark', kind: 'alias', aliasTarget: 'Neutral/900' },
						],
					},
					{
						name: 'Secondary',
						valuesByMode: [
							{ mode: 'Light', kind: 'alias', aliasTarget: 'Purple/200' },
							{ mode: 'Dark', kind: 'alias', aliasTarget: 'Purple/800' },
						],
					},
				],
			},
		],
	};
}

/** Extracts the declarations inside the first `@media (prefers-color-scheme: dark)` block. */
function darkBlock(css: string): string {
	const start = css.indexOf('@media (prefers-color-scheme: dark)');
	assert.ok(start >= 0, 'expected a dark-scheme media query');
	const end = css.indexOf('\n}', start);
	return css.slice(start, end);
}

function rootBlock(css: string): string {
	const start = css.indexOf(':root {');
	assert.ok(start >= 0, 'expected a :root block');
	return css.slice(start, css.indexOf('\n}', start));
}

suite('figma token emitter', () => {
	test('primitives become literals and semantics become var() references', () => {
		const { css, errors } = emitTokensCss(makeReport());

		assert.deepStrictEqual(errors, []);
		assert.ok(css.includes('--primitive-color-purple-700: #797596;'));
		assert.ok(css.includes('--primitive-color-neutral-0: #FFFFFF;'));
		assert.ok(css.includes('--color-primary: var(--primitive-color-purple-700);'));
		assert.ok(css.includes('--color-highlight-on-primary: var(--primitive-color-neutral-0);'));
	});

	test('semantic values never inline a hex literal', () => {
		const { css } = emitTokensCss(makeReport());

		for (const line of css.split('\n')) {
			if (line.trim().startsWith('--color-')) {
				assert.ok(
					/var\(--primitive-color-[a-z0-9-]+\)/.test(line),
					`semantic token must reference a primitive, got: ${line.trim()}`
				);
			}
		}
	});

	test('the base mode lands in :root and other modes in a media query', () => {
		const { css } = emitTokensCss(makeReport());

		const root = rootBlock(css);
		assert.ok(root.includes('--color-primary: var(--primitive-color-purple-700);'), 'Light is the base mode');
		assert.ok(!root.includes('--color-primary: var(--primitive-color-purple-500);'));

		const dark = darkBlock(css);
		assert.ok(dark.includes('--color-primary: var(--primitive-color-purple-500);'));
		assert.ok(dark.includes('--color-background: var(--primitive-color-neutral-700);'));
		assert.ok(dark.includes('--color-secondary: var(--primitive-color-purple-800);'));
	});

	test('modes that do not change a value are not repeated in the override block', () => {
		// Surface is Purple/600 in both Light and Dark; the base declaration
		// already cascades, so repeating it is noise.
		const { css, stats } = emitTokensCss(makeReport());

		assert.ok(!darkBlock(css).includes('--color-surface:'), 'unchanged token must not be re-declared');
		assert.ok(rootBlock(css).includes('--color-surface: var(--primitive-color-purple-600);'));
		// 9 primitives + 5 Light semantics + 4 changed Dark semantics.
		assert.strictEqual(stats.emittedDeclarations, 18);
	});

	test('primitives are emitted before the semantic layer that references them', () => {
		const { css } = emitTokensCss(makeReport());

		assert.ok(
			css.indexOf('--primitive-color-purple-700:') < css.indexOf('--color-primary:'),
			'primitive definitions must precede their consumers'
		);
	});

	test('counts match the extractor and are reported per mode', () => {
		const { stats } = emitTokensCss(makeReport());

		assert.strictEqual(stats.primitiveVariables, 9);
		assert.strictEqual(stats.semanticVariables, 5);
		assert.strictEqual(stats.literalModeValues, 9);
		assert.strictEqual(stats.aliasModeValues, 10);
		assert.deepStrictEqual(stats.aliasesByMode, { Light: 5, Dark: 5 });
	});

	test('a summary that disagrees with the data raises a warning', () => {
		const clean = emitTokensCss({ ...makeReport(), summary: { aliasModeValues: 10, literalModeValues: 9 } });
		assert.deepStrictEqual(clean.warnings, []);

		const stale = emitTokensCss({ ...makeReport(), summary: { aliasModeValues: 32, literalModeValues: 15 } });
		assert.ok(stale.warnings.some((w) => w.includes('32 alias mode values but 10')));
		assert.ok(stale.warnings.some((w) => w.includes('15 literal mode values but 9')));
	});

	test('a dangling alias is an error, not silently dropped output', () => {
		const report = makeReport();
		report.collections[1].variables.push({
			name: 'Accent',
			valuesByMode: [
				{ mode: 'Light', kind: 'alias', aliasTarget: 'Purple/999' },
				{ mode: 'Dark', kind: 'alias', aliasTarget: 'Purple/999' },
			],
		});

		const { css, errors } = emitTokensCss(report);

		assert.strictEqual(errors.length, 2);
		assert.ok(errors[0].includes("aliases 'Purple/999'"));
		assert.ok(!css.includes('--color-accent'));
	});

	test('a literal inside a semantic collection is flagged but still emitted', () => {
		const report = makeReport();
		report.collections[1].variables.push({
			name: 'Warning',
			valuesByMode: [
				{ mode: 'Light', kind: 'literal', value: '#FF0000' },
				{ mode: 'Dark', kind: 'literal', value: '#FF0000' },
			],
		});

		const { css, warnings, errors } = emitTokensCss(report);

		assert.deepStrictEqual(errors, []);
		assert.ok(warnings.some((w) => w.includes("'Semantic Colours' mixes 1 fixed value(s)") && w.includes("'Warning'")));
		assert.ok(css.includes('--color-warning: #FF0000;'));
	});

	test('an unrecognised mode gets an attribute hook and a warning', () => {
		const report = makeReport();
		report.collections[1].modes = ['Light', 'Dark', 'High Contrast'];
		report.collections[1].variables[0].valuesByMode.push({
			mode: 'High Contrast',
			kind: 'alias',
			aliasTarget: 'Neutral/900',
		});

		const { css, warnings } = emitTokensCss(report);

		assert.ok(warnings.some((w) => w.includes("Mode 'High Contrast'") && w.includes('no known CSS mapping')));
		assert.ok(css.includes(':root[data-mode="high-contrast"] {'));
		assert.ok(css.includes('--color-background: var(--primitive-color-neutral-900);'));
	});

	test('modeConditions overrides inference for breakpoint-style modes', () => {
		const report = makeReport();
		report.collections[1].modes = ['Light', 'Dark'];

		const { css, warnings } = emitTokensCss(report, {
			modeConditions: { Dark: { kind: 'media', query: '(min-width: 48rem)' } },
		});

		assert.deepStrictEqual(warnings, []);
		assert.ok(css.includes('@media (min-width: 48rem) {'));
		assert.ok(!css.includes('prefers-color-scheme'));
	});

	test('an alias to another semantic token resolves to the semantic prefix', () => {
		const report = makeReport();
		report.collections[1].variables.push({
			name: 'Card',
			valuesByMode: [
				{ mode: 'Light', kind: 'alias', aliasTarget: 'Surface' },
				{ mode: 'Dark', kind: 'alias', aliasTarget: 'Surface' },
			],
		});

		const { css, errors } = emitTokensCss(report);

		assert.deepStrictEqual(errors, []);
		assert.ok(css.includes('--color-card: var(--color-surface);'));
	});

	test('a non-colour collection is named from its resolvedType, not as a colour', () => {
		// "Font Sizes and Spacing" is FLOAT-typed with breakpoint modes; naming
		// it --primitive-color-* would be plainly wrong.
		const { css, warnings } = emitTokensCss(
			{
				collections: [
					{
						collection: 'Font Sizes and Spacing',
						modes: ['Desktop', 'Tablet', 'Phone'],
						variables: [
							{
								name: 'Body',
								resolvedType: 'FLOAT',
								valuesByMode: [
									{ mode: 'Desktop', kind: 'literal', value: 18, unit: 'px' },
									{ mode: 'Tablet', kind: 'literal', value: 16, unit: 'px' },
									{ mode: 'Phone', kind: 'literal', value: 16, unit: 'px' },
								],
							},
						],
					},
				],
			},
			{ modeConditions: { Tablet: { kind: 'media', query: '(max-width: 64rem)' } } }
		);

		assert.ok(css.includes('--primitive-size-body: 18px;'), 'Desktop is the base mode');
		assert.ok(css.includes('@media (max-width: 64rem)'));
		assert.ok(css.includes('--primitive-size-body: 16px;'));
		// Phone repeats Tablet's value but is a distinct context, so it is not
		// deduped against the base — only Desktop-equal values are dropped.
		assert.ok(css.includes(':root[data-mode="phone"] {'));
		assert.ok(warnings.some((w) => w.includes("Mode 'Phone'")));
	});

	test('an explicit category overrides the inferred one', () => {
		const { css } = emitTokensCss(
			{
				collections: [
					{
						collection: 'Font Sizes and Spacing',
						modes: ['Desktop'],
						variables: [
							{ name: 'Gap', resolvedType: 'FLOAT', valuesByMode: [{ mode: 'Desktop', kind: 'literal', value: 8, unit: 'px' }] },
						],
					},
				],
			},
			{ categories: { 'Font Sizes and Spacing': 'space' } }
		);

		assert.ok(css.includes('--primitive-space-gap: 8px;'));
	});

	test('numeric literals take the unit the extractor supplied', () => {
		const { css } = emitTokensCss({
			collections: [
				{
					collection: 'Spacing',
					modes: ['Mode 1'],
					variables: [
						{ name: 'Space/Small', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: 8, unit: 'px' }] },
						{ name: 'Ratio/Tight', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: 1.25 }] },
					],
				},
			],
		});

		assert.ok(css.includes('--primitive-color-space-small: 8px;'));
		assert.ok(css.includes('--primitive-color-ratio-tight: 1.25;'));
	});

	test('text styles emit custom properties and matching utility classes', () => {
		const { css, stats } = emitTokensCss({
			collections: [],
			textStyles: [
				{
					name: 'Heading/H1',
					fontFamily: 'Inter',
					fontWeight: 700,
					fontSize: 48,
					lineHeight: '120%',
					letterSpacing: -0.5,
					textCase: 'UPPER',
				},
			],
		});

		assert.strictEqual(stats.textStyles, 1);
		assert.ok(css.includes('--text-heading-h1-font-family: Inter;'), 'a single-word family needs no quotes');
		assert.ok(css.includes('--text-heading-h1-font-size: 48px;'));
		assert.ok(css.includes('--text-heading-h1-line-height: 120%;'), 'string values keep their unit');
		assert.ok(css.includes('--text-heading-h1-letter-spacing: -0.5px;'));
		assert.ok(css.includes('--text-heading-h1-text-transform: uppercase;'), "Figma's UPPER maps to CSS");
		assert.ok(css.includes('.text-heading-h1 {'));
		assert.ok(css.includes('font-size: var(--text-heading-h1-font-size);'));
		assert.ok(!css.includes('text-decoration'), 'absent properties are omitted');
	});

	test("Figma font style names become CSS weights, italic included", () => {
		const { css, warnings } = emitTokensCss({
			collections: [],
			textStyles: [
				{ name: 'Body', fontWeight: 'Regular' },
				{ name: 'Lead', fontWeight: 'SemiBold' },
				// DM Sans reports this exact style name in the wild.
				{ name: 'Nav', fontWeight: '9pt Regular' },
				{ name: 'Quote', fontWeight: 'Bold Italic' },
				{ name: 'Odd', fontWeight: 'Condensed' },
			],
		});

		assert.ok(css.includes('--text-body-font-weight: 400;'));
		assert.ok(css.includes('--text-lead-font-weight: 600;'), 'semibold must not match bold');
		assert.ok(css.includes('--text-nav-font-weight: 400;'), 'a decorated style name still resolves');
		assert.ok(css.includes('--text-quote-font-weight: 700;'));
		assert.ok(css.includes('--text-quote-font-style: italic;'), 'italic is split out of the weight');
		// Unrecognised names survive into the CSS rather than disappearing.
		assert.ok(css.includes('--text-odd-font-weight: Condensed;'));
		assert.ok(warnings.some((w) => w.includes("'Odd'") && w.includes('not a CSS weight')));
		assert.strictEqual(warnings.filter((w) => w.includes('not a CSS weight')).length, 1);
	});

	test('multi-word font families are quoted', () => {
		const { css } = emitTokensCss({
			collections: [],
			textStyles: [{ name: 'Title', fontFamily: 'Playfair Display' }],
		});

		assert.ok(css.includes('--text-title-font-family: "Playfair Display";'));
	});

	test('float noise from Figma is rounded', () => {
		const { css } = emitTokensCss({
			collections: [
				{
					collection: 'Spacing',
					modes: ['M'],
					variables: [
						{ name: 'Nudge', resolvedType: 'FLOAT', valuesByMode: [{ mode: 'M', kind: 'literal', value: 7.000000476837158, unit: 'px' }] },
					],
				},
			],
			textStyles: [{ name: 'Sub', letterSpacing: 1.2000000476837158 }],
		});

		assert.ok(css.includes('--primitive-size-nudge: 7px;'));
		assert.ok(css.includes('--text-sub-letter-spacing: 1.2px;'));
	});

	/** A collection whose modes overlap as max-width breakpoints. */
	function responsiveReport(): FigmaTokenReport {
		return {
			collections: [
				{
					collection: 'Font Sizes and Spacing',
					modes: ['Desktop', 'Phone', 'Tablet'],
					variables: [
						{
							name: 'SectionPaddingHorizontal',
							resolvedType: 'FLOAT',
							valuesByMode: [
								{ mode: 'Desktop', kind: 'literal', value: 0, unit: 'px' },
								{ mode: 'Phone', kind: 'literal', value: 32, unit: 'px' },
								{ mode: 'Tablet', kind: 'literal', value: 16, unit: 'px' },
							],
						},
					],
				},
			],
		};
	}

	test('override blocks follow modeConditions order, not the order modes appear in Figma', () => {
		// Figma lists Phone before Tablet, but with max-width queries the wider
		// one must come first or it overrides the narrower one on a phone.
		const { css, warnings } = emitTokensCss(responsiveReport(), {
			modeConditions: {
				Tablet: { kind: 'media', query: '(max-width: 64rem)' },
				Phone: { kind: 'media', query: '(max-width: 40rem)' },
			},
		});

		assert.deepStrictEqual(warnings, []);
		assert.ok(
			css.indexOf('(max-width: 64rem)') < css.indexOf('(max-width: 40rem)'),
			'the wider max-width block must be emitted first'
		);
	});

	test('a cascade-hostile breakpoint order is reported', () => {
		const { warnings } = emitTokensCss(responsiveReport(), {
			modeConditions: {
				Phone: { kind: 'media', query: '(max-width: 40rem)' },
				Tablet: { kind: 'media', query: '(max-width: 64rem)' },
			},
		});

		assert.ok(
			warnings.some((w) => w.includes('(max-width: 64rem)') && w.includes('overrides')),
			`expected a cascade-order warning, got: ${JSON.stringify(warnings)}`
		);
	});

	test('min-width breakpoints want the opposite order', () => {
		const ascending = emitTokensCss(responsiveReport(), {
			modeConditions: {
				Phone: { kind: 'media', query: '(min-width: 40rem)' },
				Tablet: { kind: 'media', query: '(min-width: 64rem)' },
			},
		});
		assert.deepStrictEqual(ascending.warnings, []);

		const descending = emitTokensCss(responsiveReport(), {
			modeConditions: {
				Tablet: { kind: 'media', query: '(min-width: 64rem)' },
				Phone: { kind: 'media', query: '(min-width: 40rem)' },
			},
		});
		assert.ok(descending.warnings.some((w) => w.includes('overrides')));
	});

	test('emitting is deterministic', () => {
		assert.strictEqual(emitTokensCss(makeReport()).css, emitTokensCss(makeReport()).css);
	});

	test('names collapse to kebab-case CSS identifiers', () => {
		assert.strictEqual(toKebabCase('Purple/100'), 'purple-100');
		assert.strictEqual(toKebabCase('Highlight on Surface'), 'highlight-on-surface');
		assert.strictEqual(toKebabCase('fontSize'), 'font-size');
		assert.strictEqual(toKebabCase('  Spacing / 2X Large  '), 'spacing-2x-large');
	});

	test('two names that collapse to the same identifier are flagged', () => {
		const { warnings } = emitTokensCss({
			collections: [
				{
					collection: 'Primitive Colours',
					modes: ['Mode 1'],
					variables: [
						{ name: 'Purple/100', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: '#111111' }] },
						{ name: 'purple 100', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: '#222222' }] },
					],
				},
			],
		});

		assert.ok(warnings.some((w) => w.includes('--primitive-color-purple-100')));
	});
});

/**
 * Students point this at whatever design they have. These cover the shapes a
 * real Figma file takes when it was not built to the two-layer convention.
 */
suite('figma token emitter — unconventional files', () => {
	function oneCollection(variables: FigmaTokenReport['collections'][0]['variables'], modes = ['Mode 1']) {
		return { collections: [{ collection: 'Colors', modes, variables }] };
	}

	test('a file with no variables says so instead of writing an empty stylesheet', () => {
		for (const report of [{ collections: [] }, oneCollection([])]) {
			const { warnings, errors } = emitTokensCss(report);
			assert.deepStrictEqual(errors, []);
			assert.ok(warnings.some((w) => w.includes('No variables found')));
		}
	});

	test('one collection mixing fixed values and aliases still produces a correct graph', () => {
		const { css, warnings, errors } = emitTokensCss(
			oneCollection([
				{ name: 'Red', resolvedType: 'COLOR', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: '#F00' }] },
				{ name: 'Danger', resolvedType: 'COLOR', valuesByMode: [{ mode: 'Mode 1', kind: 'alias', aliasTarget: 'Red' }] },
				{ name: 'Blue', resolvedType: 'COLOR', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: '#00F' }] },
			])
		);

		assert.deepStrictEqual(errors, []);
		assert.ok(css.includes('--color-red: #F00;'));
		assert.ok(css.includes('--color-danger: var(--color-red);'), 'the alias must resolve within the same layer');
		// One note for the collection, not one per fixed value.
		assert.strictEqual(warnings.length, 1);
		assert.ok(warnings[0].includes("'Colors' mixes 2 fixed value(s)"));
	});

	test('a value that would escape the CSS rule is rejected, not emitted', () => {
		const { css, errors } = emitTokensCss(
			oneCollection([
				{ name: 'Evil', resolvedType: 'STRING', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: 'red; } body { display:none' }] },
				{ name: 'Fine', resolvedType: 'COLOR', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: '#0F0' }] },
			])
		);

		assert.ok(!css.includes('display:none'), 'the stylesheet must not be breakable from Figma content');
		assert.ok(!css.includes('-evil'));
		// Prefix left unasserted: the point is that one bad token does not
		// take the rest of the collection down with it.
		assert.ok(css.includes('-fine: #0F0;'), 'other tokens still come through');
		assert.ok(errors.some((e) => e.includes("'Evil'") && e.includes('break out')));
	});

	test('a quoted value containing punctuation is allowed through', () => {
		const { css, errors } = emitTokensCss(
			oneCollection([
				{ name: 'Stack', resolvedType: 'STRING', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: '"Helvetica Neue", sans-serif' }] },
			])
		);

		assert.deepStrictEqual(errors, []);
		assert.ok(css.includes('--primitive-string-stack: "Helvetica Neue", sans-serif;'));
	});

	test('an alias cycle is reported rather than silently killing the page', () => {
		const { errors } = emitTokensCss(
			oneCollection([
				{ name: 'A', resolvedType: 'COLOR', valuesByMode: [{ mode: 'Mode 1', kind: 'alias', aliasTarget: 'B' }] },
				{ name: 'B', resolvedType: 'COLOR', valuesByMode: [{ mode: 'Mode 1', kind: 'alias', aliasTarget: 'A' }] },
			])
		);

		assert.strictEqual(errors.length, 1);
		assert.ok(errors[0].includes('Alias cycle'));
		assert.ok(errors[0].includes('--color-a') && errors[0].includes('--color-b'));
	});

	test('a longer alias chain is not mistaken for a cycle', () => {
		const { errors } = emitTokensCss(
			oneCollection([
				{ name: 'Base', resolvedType: 'COLOR', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: '#111' }] },
				{ name: 'Mid', resolvedType: 'COLOR', valuesByMode: [{ mode: 'Mode 1', kind: 'alias', aliasTarget: 'Base' }] },
				{ name: 'Top', resolvedType: 'COLOR', valuesByMode: [{ mode: 'Mode 1', kind: 'alias', aliasTarget: 'Mid' }] },
			])
		);

		assert.deepStrictEqual(errors, []);
	});

	test('non-Latin names survive instead of collapsing', () => {
		const { css, warnings } = emitTokensCss(
			oneCollection([
				{ name: 'Röd/100', resolvedType: 'COLOR', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: '#F00' }] },
				{ name: '蓝色/100', resolvedType: 'COLOR', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: '#00F' }] },
			])
		);

		assert.ok(css.includes('--primitive-color-röd-100: #F00;'));
		assert.ok(css.includes('--primitive-color-蓝色-100: #00F;'));
		assert.deepStrictEqual(warnings, []);
	});

	test('a name with no usable characters keeps its token under a positional name', () => {
		const { css, warnings } = emitTokensCss(
			oneCollection([
				{ name: '???', resolvedType: 'COLOR', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: '#123456' }] },
				{ name: '---', resolvedType: 'COLOR', valuesByMode: [{ mode: 'Mode 1', kind: 'literal', value: '#654321' }] },
			])
		);

		assert.ok(!/--primitive-color-:/.test(css), 'must never emit a bare prefix as a property name');
		assert.ok(css.includes('--primitive-color-unnamed-1: #123456;'));
		assert.ok(css.includes('--primitive-color-unnamed-2: #654321;'));
		assert.strictEqual(warnings.length, 2);
	});

	test('a variable missing a value for a declared mode is reported', () => {
		const { css, warnings } = emitTokensCss(
			oneCollection(
				[{ name: 'X', resolvedType: 'COLOR', valuesByMode: [{ mode: 'Light', kind: 'literal', value: '#111' }] }],
				['Light', 'Dark']
			)
		);

		assert.ok(css.includes('--primitive-color-x: #111;'));
		assert.ok(warnings.some((w) => w.includes("'X' has no value for mode 'Dark'")));
	});
});

suite('figma mode configuration', () => {
	test('the chosen base mode moves to the front, so it lands in :root', () => {
		const report: FigmaTokenReport = {
			collections: [
				{
					collection: 'Semantic Colours',
					modes: ['Dark', 'Light'],
					variables: [
						{
							name: 'Background',
							valuesByMode: [
								{ mode: 'Dark', kind: 'literal', value: '#000' },
								{ mode: 'Light', kind: 'literal', value: '#FFF' },
							],
						},
					],
				},
			],
		};

		// Figma happens to list Dark first; the student picks Light as default.
		const { css } = emitTokensCss(applyBaseModes(report, { 'Semantic Colours': 'Light' }));

		assert.ok(rootBlock(css).includes('--primitive-color-background: #FFF;'));
		assert.ok(css.includes('@media (prefers-color-scheme: dark)'));
		assert.ok(darkBlock(css).includes('--primitive-color-background: #000;'));
	});

	test('applying base modes leaves unknown collections and single-mode ones alone', () => {
		const report: FigmaTokenReport = {
			collections: [
				{ collection: 'A', modes: ['Only'], variables: [] },
				{ collection: 'B', modes: ['X', 'Y'], variables: [] },
			],
		};

		const out = applyBaseModes(report, { Missing: 'Z' });

		assert.deepStrictEqual(out.collections[0].modes, ['Only']);
		assert.deepStrictEqual(out.collections[1].modes, ['X', 'Y']);
	});

	test('max-width conditions are ordered widest first and min-width narrowest first', () => {
		const max = orderModeConditions({
			Phone: { kind: 'media', query: '(max-width: 40rem)' },
			Tablet: { kind: 'media', query: '(max-width: 64rem)' },
		});
		assert.deepStrictEqual(Object.keys(max), ['Tablet', 'Phone']);

		const min = orderModeConditions({
			Desktop: { kind: 'media', query: '(min-width: 64rem)' },
			Tablet: { kind: 'media', query: '(min-width: 40rem)' },
		});
		assert.deepStrictEqual(Object.keys(min), ['Tablet', 'Desktop']);
	});

	test('ordering makes the emitter stop complaining about the cascade', () => {
		const report: FigmaTokenReport = {
			collections: [
				{
					collection: 'Sizes',
					modes: ['Desktop', 'Phone', 'Tablet'],
					variables: [
						{
							name: 'Pad',
							resolvedType: 'FLOAT',
							valuesByMode: [
								{ mode: 'Desktop', kind: 'literal', value: 0, unit: 'px' },
								{ mode: 'Phone', kind: 'literal', value: 32, unit: 'px' },
								{ mode: 'Tablet', kind: 'literal', value: 16, unit: 'px' },
							],
						},
					],
				},
			],
		};
		// Deliberately the wrong way round, as a student's answers might arrive.
		const chosen: Record<string, ModeCondition> = {
			Phone: { kind: 'media', query: '(max-width: 40rem)' },
			Tablet: { kind: 'media', query: '(max-width: 64rem)' },
		};

		assert.ok(emitTokensCss(report, { modeConditions: chosen }).warnings.some((w) => w.includes('overrides')));
		assert.deepStrictEqual(
			emitTokensCss(report, { modeConditions: orderModeConditions(chosen) }).warnings,
			[]
		);
	});

	test('conditions with no width bound keep their given order', () => {
		const ordered = orderModeConditions({
			Dark: { kind: 'media', query: '(prefers-color-scheme: dark)' },
			Brand: { kind: 'selector', selector: ':root[data-mode="brand"]' },
			Print: { kind: 'media', query: 'print' },
		});

		assert.deepStrictEqual(Object.keys(ordered), ['Dark', 'Brand', 'Print']);
	});
});

suite('figma frame matching', () => {
	const FRAMES = [
		{ name: 'Desktop — Home', width: 1440, height: 3200, page: 'Pages' },
		{ name: 'Desktop — About', width: 1440, height: 2400, page: 'Pages' },
		{ name: 'Tablet — Home', width: 768, height: 3600, page: 'Pages' },
		{ name: 'Phone — Home', width: 375, height: 4200, page: 'Pages' },
		{ name: 'Components', width: 900, height: 900, page: 'Library' },
	];

	const widths = (frames: any, mode: string) =>
		findFrameCandidatesForMode(frames, mode).map((f) => f.width);

	test('a mode finds the artboard it was designed at', () => {
		assert.deepStrictEqual(widths(FRAMES, 'Tablet'), [768]);
		assert.deepStrictEqual(widths(FRAMES, 'Phone'), [375]);
		assert.deepStrictEqual(widths(FRAMES, 'Desktop'), [1440]);
	});

	test('icon components named after devices cannot become the breakpoint', () => {
		// Every icon set has phone/tablet/desktop icons, usually several
		// variants, so by frequency alone they would outvote the real layout.
		const frames = [
			{ name: 'Phone', width: 24, height: 24, page: 'Icons' },
			{ name: 'Phone', width: 24, height: 24, page: 'Icons' },
			{ name: 'Phone', width: 48, height: 48, page: 'Icons' },
			{ name: 'Phone — Home', width: 375, height: 4200, page: 'Pages' },
		];

		assert.deepStrictEqual(widths(frames, 'Phone'), [375]);
	});

	test('an annotation frame sharing the name is offered, never chosen silently', () => {
		const frames = [
			{ name: 'Tablet — Home', width: 768, height: 3600, page: 'Pages' },
			{ name: 'Tablet Annotations', width: 1440, height: 900, page: 'Notes' },
		];

		// Both come back so the student picks; guessing here once produced a
		// 1440px tablet breakpoint.
		assert.deepStrictEqual(widths(frames, 'Tablet'), [768, 1440]);
	});

	test('the layout leads when most artboards agree on a width', () => {
		const frames = [
			{ name: 'Tablet — Home', width: 768 },
			{ name: 'Tablet — About', width: 768 },
			{ name: 'Tablet — Scratch', width: 820 },
		];

		assert.deepStrictEqual(widths(frames, 'Tablet'), [768, 820]);
	});

	test('one representative per distinct width, not one per frame', () => {
		assert.deepStrictEqual(findFrameCandidatesForMode(FRAMES, 'Desktop').length, 1);
	});

	test('matching is on whole words, so modes do not collide', () => {
		assert.deepStrictEqual(widths(FRAMES, 'Mobile'), []);
		assert.deepStrictEqual(widths([{ name: 'Tablet', width: 768 }], 'Desktop'), []);
	});

	test('a multi-word mode needs all of its words present', () => {
		const frames = [
			{ name: 'High Contrast — Home', width: 1440 },
			{ name: 'Contrast Study', width: 600 },
		];

		assert.deepStrictEqual(widths(frames, 'High Contrast'), [1440]);
	});

	test('frames with no mode word in their name are inert', () => {
		assert.deepStrictEqual(widths([{ name: 'Colour Palette', width: 1200 }], 'Tablet'), []);
	});

	test('no frames, no match, no crash', () => {
		assert.deepStrictEqual(findFrameCandidatesForMode(undefined, 'Tablet'), []);
		assert.deepStrictEqual(findFrameCandidatesForMode([], 'Tablet'), []);
		assert.deepStrictEqual(findFrameCandidatesForMode(FRAMES, '???'), []);
	});

	test('frames are advisory and never reach the stylesheet', () => {
		const { css } = emitTokensCss({
			collections: [
				{
					collection: 'C',
					modes: ['M'],
					variables: [{ name: 'X', resolvedType: 'COLOR', valuesByMode: [{ mode: 'M', kind: 'literal', value: '#111' }] }],
				},
			],
			frames: FRAMES,
		});

		assert.ok(css.includes('--primitive-color-x: #111;'));
		assert.ok(!css.includes('Desktop'), 'frame names must not leak into the CSS');
		assert.ok(!css.includes('1440'));
	});

	test('malformed frames are dropped without failing the import', () => {
		const parsed = parseFigmaTokenReport({
			collections: [],
			frames: [
				{ name: 'Good', width: 1440, height: 900, page: 'P' },
				{ name: 'No width' },
				{ width: 100 },
				{ name: 'NaN width', width: 'wide' },
				'not an object',
			],
		});

		assert.deepStrictEqual(parsed.frames, [{ name: 'Good', width: 1440, height: 900, page: 'P' }]);
	});
});

suite('figma token report parsing', () => {
	test('the extractor payload round-trips through JSON', () => {
		const raw = JSON.parse(JSON.stringify(makeReport()));
		const parsed = parseFigmaTokenReport(raw);

		assert.strictEqual(parsed.collections.length, 2);
		assert.deepStrictEqual(parsed.collections[1].modes, ['Light', 'Dark']);
		assert.strictEqual(emitTokensCss(parsed).errors.length, 0);
	});

	test('a summary is preserved so the cross-check can run', () => {
		const parsed = parseFigmaTokenReport({
			summary: { aliasModeValues: 32, literalModeValues: 15 },
			collections: [],
		});

		assert.deepStrictEqual(parsed.summary, { aliasModeValues: 32, literalModeValues: 15 });
	});

	test('malformed reports are rejected with a locating message', () => {
		assert.throws(() => parseFigmaTokenReport(null), /no 'collections' array/);
		assert.throws(() => parseFigmaTokenReport({ collections: {} }), /no 'collections' array/);
		assert.throws(
			() => parseFigmaTokenReport({ collections: [{ collection: 'A', modes: ['M'], variables: [{ name: 'x' }] }] }),
			/collections\[0\].variables\[0\]: missing 'valuesByMode'/
		);
		assert.throws(
			() =>
				parseFigmaTokenReport({
					collections: [
						{
							collection: 'A',
							modes: ['M'],
							variables: [{ name: 'x', valuesByMode: [{ mode: 'M', kind: 'alias' }] }],
						},
					],
				}),
			/has no aliasTarget/
		);
	});
});
