import { describe, it, expect } from 'vitest';
import { extractParams, sanitizeName } from './runner';

describe('extractParams', () => {
  it('plain identifier', () => {
    expect(extractParams('(x)')).toEqual(['x']);
  });

  it('strips TS type annotation', () => {
    expect(extractParams('(raw: string) => Parsed')).toEqual(['raw']);
  });

  it('preserves default values after type annotation', () => {
    expect(extractParams('(a: number, b: number = 2) => number')).toEqual([
      'a',
      'b = 2',
    ]);
  });

  it('preserves default values without type annotation', () => {
    expect(extractParams('(a, b = 5)')).toEqual(['a', 'b = 5']);
  });

  it('empty params', () => {
    expect(extractParams('() => void')).toEqual([]);
  });

  it('no parens at all', () => {
    expect(extractParams('void')).toEqual([]);
  });

  it('python def — strips def prefix, grabs first parens', () => {
    expect(extractParams('def f(x: int, y=5) -> int')).toEqual(['x', 'y = 5']);
  });

  it('multiple plain params', () => {
    expect(extractParams('(a, b, c)')).toEqual(['a', 'b', 'c']);
  });

  it('trailing comma is dropped', () => {
    expect(extractParams('(a, b,)')).toEqual(['a', 'b']);
  });

  it('rest params pass through', () => {
    expect(extractParams('(...args)')).toEqual(['...args']);
  });

  it('extra whitespace is trimmed', () => {
    expect(extractParams('(  a  ,   b  )')).toEqual(['a', 'b']);
  });

  it('TS generic with comma inside does not split on that comma', () => {
    expect(extractParams('(m: Map<string, number>, n: number)')).toEqual([
      'm',
      'n',
    ]);
  });

  it('nested generic with multiple inner commas', () => {
    expect(
      extractParams('(x: Record<string, Array<number>>, y: string)'),
    ).toEqual(['x', 'y']);
  });

  it('object-literal default with commas inside', () => {
    expect(extractParams('(a = {x: 1, y: 2}, b)')).toEqual([
      'a = {x: 1, y: 2}',
      'b',
    ]);
  });

  it('array-literal default with commas inside', () => {
    expect(extractParams('(arr = [1, 2, 3])')).toEqual(['arr = [1, 2, 3]']);
  });

  it('destructured object parameter stays whole', () => {
    expect(extractParams('({a, b})')).toEqual(['{a, b}']);
  });

  it('destructured object with type annotation', () => {
    expect(extractParams('({a, b}: {a: number, b: number})')).toEqual(['{a, b}']);
  });

  it('function-typed parameter with its own parens', () => {
    expect(
      extractParams('(f: (x: number) => number, seed: number)'),
    ).toEqual(['f', 'seed']);
  });
});

describe('sanitizeName', () => {
  it('valid JS identifier is unchanged', () => {
    expect(sanitizeName('fooBar')).toBe('fooBar');
  });

  it('underscores and digits allowed', () => {
    expect(sanitizeName('foo_bar_42')).toBe('foo_bar_42');
  });

  it('hyphens replaced with underscore', () => {
    expect(sanitizeName('my-fn')).toBe('my_fn');
  });

  it('special characters replaced', () => {
    expect(sanitizeName('my-fn!')).toBe('my_fn_');
  });

  it('digit-starting name gets underscore prefix', () => {
    expect(sanitizeName('42fn')).toBe('_42fn');
  });

  it('empty string becomes _', () => {
    expect(sanitizeName('')).toBe('_');
  });

  it('all-special-chars becomes underscores', () => {
    expect(sanitizeName('!!!')).toBe('___');
  });

  it('dollar sign preserved', () => {
    expect(sanitizeName('$jq')).toBe('$jq');
  });
});
