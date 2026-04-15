import { FunctionBlockData } from './types';

export interface BlockTemplate {
  id: string;
  label: string;
  description: string;
  /**
   * Partial override applied on top of defaultBlockData(name). Leave any
   * field undefined to inherit the default.
   */
  data: Partial<FunctionBlockData>;
}

/**
 * Preset block shapes for common patterns. Picking one from the Templates
 * modal creates a new block seeded with these fields so the user doesn't
 * have to re-enter the same boilerplate each time.
 */
export const TEMPLATES: BlockTemplate[] = [
  {
    id: 'js-pure',
    label: 'JS · Pure transform',
    description: 'A deterministic input→output function with a single equality test.',
    data: {
      name: 'transform',
      language: 'javascript',
      signature: '(input) => output',
      mode: 'TDD',
      tests:
        `test('doubles the number', () => {\n` +
        `  expect(transform(3)).toBe(6);\n` +
        `});`,
      spec: 'Return the input value doubled.',
    },
  },
  {
    id: 'js-validator',
    label: 'JS · Validator',
    description: 'Throws on invalid input, returns the normalized value on success.',
    data: {
      name: 'validateEmail',
      language: 'javascript',
      signature: '(s) => string',
      mode: 'TDD',
      tests:
        `test('accepts valid email', () => {\n` +
        `  expect(validateEmail('a@b.co')).toBe('a@b.co');\n` +
        `});\n` +
        `test('rejects missing at-sign', () => {\n` +
        `  expect(() => validateEmail('abc')).toThrow('invalid');\n` +
        `});`,
      spec: 'Return the email lowercased. Throw Error("invalid") if there is no @.',
    },
  },
  {
    id: 'js-string',
    label: 'JS · String sanitizer',
    description: 'Trims, lowercases, removes non-alphanumeric characters.',
    data: {
      name: 'slugify',
      language: 'javascript',
      signature: '(s) => string',
      mode: 'TDD',
      tests:
        `test('lowercases and strips', () => {\n` +
        `  expect(slugify('Hello World!')).toBe('hello-world');\n` +
        `});\n` +
        `test('trims whitespace', () => {\n` +
        `  expect(slugify('  hi  ')).toBe('hi');\n` +
        `});`,
      spec: 'Lowercase, trim, replace runs of whitespace with "-", strip non-alphanumerics except "-".',
    },
  },
  {
    id: 'js-fetch',
    label: 'JS · Async fetch',
    description: 'Async function that calls fetch and returns parsed JSON. Free-form (no sandbox).',
    data: {
      name: 'fetchUser',
      language: 'javascript',
      signature: 'async (id) => User',
      mode: 'manual',
      spec:
        'Fetch /api/users/:id, parse JSON, return the object. ' +
        'Throw on non-2xx. No tests — network-bound.',
    },
  },
  {
    id: 'py-list',
    label: 'Python · List processor',
    description: 'Takes a list, returns a new list, with one toEqual assertion.',
    data: {
      name: 'unique_sorted',
      language: 'python',
      signature: 'def unique_sorted(xs: list) -> list',
      mode: 'TDD',
      tests:
        `test('dedupes and sorts', lambda: expect(unique_sorted([3, 1, 2, 1])).toEqual([1, 2, 3]))\n` +
        `test('empty list stays empty', lambda: expect(unique_sorted([])).toEqual([]))`,
      spec: 'Return a new list containing each unique element of xs, sorted ascending.',
    },
  },
];
