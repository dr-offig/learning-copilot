import * as assert from 'assert';

import { countLayoutNodes, listUsedTokens, renderLayoutOutline } from '../figmalayout';
import type { FigmaLayoutReport } from '../figmatokens';

function makeLayouts(): FigmaLayoutReport[] {
	return [
		{
			page: 'Page 1',
			root: {
				name: 'Desktop',
				type: 'FRAME',
				width: 1440,
				height: 3000,
				layout: 'vertical',
				children: [
					{
						name: 'Hero',
						type: 'FRAME',
						width: 1440,
						height: 600,
						layout: 'vertical',
						gap: 24,
						padding: [64, 32, 64, 32],
						align: 'CENTER',
						bound: { fills: 'Surface' },
						children: [
							{
								name: 'Title',
								type: 'TEXT',
								text: 'Learn to build websites',
								style: 'Heading1',
								bound: { fills: 'Highlight on Background' },
							},
							{ name: 'Button/Primary', type: 'INSTANCE', width: 160, height: 48 },
						],
					},
				],
			},
		},
	];
}

suite('figma layout outline', () => {
	test('nesting is expressed by indentation', () => {
		const out = renderLayoutOutline(makeLayouts()).split('\n');

		const hero = out.find((l) => l.includes('"Hero"'))!;
		const title = out.find((l) => l.includes('"Title"'))!;
		assert.ok(hero.startsWith('- '), `expected Hero at top level, got: ${hero}`);
		assert.ok(title.startsWith('  - '), `expected Title nested under Hero, got: ${title}`);
	});

	test('the artboard becomes the heading, not a list item', () => {
		const out = renderLayoutOutline(makeLayouts());

		assert.ok(out.startsWith('## Desktop (1440×3000)'));
		assert.ok(out.includes('_Figma page: Page 1_'));
		assert.ok(!out.includes('- FRAME "Desktop"'), 'the root should not repeat as a bullet');
	});

	test('padding collapses the way CSS shorthand does', () => {
		const layouts = makeLayouts();
		assert.ok(renderLayoutOutline(layouts).includes('padding 64 32'));

		layouts[0].root.children![0].padding = [32, 32, 32, 32];
		assert.ok(renderLayoutOutline(layouts).includes('padding 32'));

		layouts[0].root.children![0].padding = [1, 2, 3, 4];
		assert.ok(renderLayoutOutline(layouts).includes('padding 1 2 3 4'));

		layouts[0].root.children![0].padding = [0, 0, 0, 0];
		assert.ok(!renderLayoutOutline(layouts).includes('padding'));
	});

	test('bound tokens and text styles are named, since that is the whole point', () => {
		const out = renderLayoutOutline(makeLayouts());

		// Naming the token is what lets generated CSS use var(--color-surface)
		// instead of inventing a hex the model guessed from a screenshot.
		assert.ok(out.includes('tokens: fills=Surface'));
		assert.ok(out.includes('tokens: fills=Highlight on Background'));
		assert.ok(out.includes('text style "Heading1"'));
	});

	test('text is quoted on its own line', () => {
		const out = renderLayoutOutline(makeLayouts());

		assert.ok(out.includes('text: "Learn to build websites"'));
	});

	test('a nameless text layer is labelled by its own content', () => {
		// The extractor drops a text layer's name when Figma had merely named
		// it after its content; the outline must not then print "undefined".
		const out = renderLayoutOutline([
			{ root: { name: 'A', type: 'FRAME', children: [{ type: 'TEXT', text: 'Get in touch', style: 'ButtonLabel' }] } },
		]);

		assert.ok(!out.includes('undefined'), out);
		assert.ok(out.includes('TEXT "Get in touch" · text style "ButtonLabel"'));
		assert.ok(!out.includes('text: "Get in touch"'), 'short text should not also repeat on its own line');
	});

	test('long nameless text still gets its own line rather than a giant label', () => {
		const long = 'Creative Sparks is a full-service design agency crafting visual identities and campaigns';
		const out = renderLayoutOutline([
			{ root: { name: 'A', type: 'FRAME', children: [{ type: 'TEXT', text: long, style: 'Body' }] } },
		]);

		assert.ok(!out.includes('undefined'));
		assert.ok(out.includes('- TEXT · text style "Body"'));
		assert.ok(out.includes(`text: ${JSON.stringify(long)}`));
	});

	test('alignment words are translated out of Figma-speak', () => {
		const layouts = makeLayouts();
		layouts[0].root.children![0].justify = 'SPACE_BETWEEN';

		const out = renderLayoutOutline(layouts);
		assert.ok(out.includes('justify space-between'));
		assert.ok(out.includes('align center'));
		assert.ok(!out.includes('SPACE_BETWEEN'));
		assert.ok(!out.includes('CENTER'));
	});

	test('an empty or absent layout set renders nothing at all', () => {
		assert.strictEqual(renderLayoutOutline(undefined), '');
		assert.strictEqual(renderLayoutOutline([]), '');
	});

	test('an artboard with no children says so rather than rendering blank', () => {
		const out = renderLayoutOutline([{ root: { name: 'Empty', type: 'FRAME' } }]);

		assert.ok(out.includes('## Empty'));
		assert.ok(out.includes('no visible children'));
	});

	test('leaf types are not descended into', () => {
		const out = renderLayoutOutline([
			{
				root: {
					name: 'A',
					type: 'FRAME',
					children: [
						{ name: 'Photo', type: 'RECTANGLE', children: [{ name: 'should not appear', type: 'TEXT' }] },
					],
				},
			},
		]);

		assert.ok(out.includes('"Photo"'));
		assert.ok(!out.includes('should not appear'));
	});

	test('the heading level is configurable for embedding in a larger document', () => {
		assert.ok(renderLayoutOutline(makeLayouts(), { headingLevel: 3 }).startsWith('### Desktop'));
		// Clamped rather than emitting an invalid heading.
		assert.ok(renderLayoutOutline(makeLayouts(), { headingLevel: 99 }).startsWith('###### Desktop'));
		assert.ok(renderLayoutOutline(makeLayouts(), { headingLevel: 0 }).startsWith('# Desktop'));
	});
});

suite('figma layout summaries', () => {
	test('used tokens are deduplicated and sorted', () => {
		const layouts = makeLayouts();
		layouts[0].root.children![0].children!.push({
			name: 'Second',
			type: 'TEXT',
			style: 'Heading1',
			bound: { fills: 'Surface' },
		});

		assert.deepStrictEqual(listUsedTokens(layouts), [
			'Heading1',
			'Highlight on Background',
			'Surface',
		]);
	});

	test('token and node counts survive an empty set', () => {
		assert.deepStrictEqual(listUsedTokens(undefined), []);
		assert.strictEqual(countLayoutNodes(undefined), 0);
	});

	test('nodes are counted through the whole tree', () => {
		// Desktop + Hero + Title + Button.
		assert.strictEqual(countLayoutNodes(makeLayouts()), 4);
	});
});
