import { expect, test } from 'vitest';
import { markdownTableAlignments, markdownTableRow } from '../../src/web/markdown.ts';

test('Markdown table syntax handles alignment and escaped pipes', () => {
  expect(markdownTableAlignments([':---', '---:', ':---:'])).toEqual(['left', 'right', 'center']);
  expect(markdownTableAlignments(['--', '---'])).toBeNull();
  expect(markdownTableRow('| Agent | Description |')).toEqual(['Agent', 'Description']);
  expect(markdownTableRow('| coder | writes \\| tests |')).toEqual(['coder', 'writes | tests']);
  expect(markdownTableRow('plain paragraph')).toBeNull();
});
