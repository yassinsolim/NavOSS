import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const editor = readFileSync(
  resolve(import.meta.dirname, '..', 'src/features/navigation/route-stops-editor.tsx'),
  'utf8',
);

describe('route stops editor', () => {
  it('does not reseed an open draft when the parent replaces destinations array identity', () => {
    expect(editor).toMatch(
      /useEffect\(\(\) => \{\s+if \(visible && !previousVisibleRef\.current\) \{[\s\S]*?setDraft\(\[\.\.\.destinations\]\);[\s\S]*?\}\s+previousVisibleRef\.current = visible;\s+\}, \[destinations, searchRequestGate, visible\]\);/,
    );
  });

  it('debounces place search without dismissing the keyboard and exposes its outcome', () => {
    expect(editor).toContain('const timeout = setTimeout(() => {');
    expect(editor).toContain('}, 250);');
    expect(editor).toContain('blurOnSubmit={false}');
    expect(editor).not.toContain('Keyboard.dismiss()');
    expect(editor).toContain('No places found');
    expect(editor).toContain('Add stop</Text>');
  });

  it('adds a selected result to the draft that Done applies', () => {
    expect(editor).toContain('setDraft((current) => [...current, result]);');
    expect(editor).toContain('onApply(draft);');
  });
});
