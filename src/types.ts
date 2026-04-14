export type DevMode = 'TDD' | 'SDD' | 'manual';

export type BlockStatus =
  | 'stub'
  | 'specd'
  | 'generating'
  | 'running_tests'
  | 'passing'
  | 'failing';

export interface TestCounts {
  passed: number;
  total: number;
}

export interface FunctionBlockData {
  name: string;
  signature: string;
  mode: DevMode;
  spec: string;
  tests: string;
  scope: string[];
  body: string;
  status: BlockStatus;
  language: string;
  /** Last test run summary. Cleared when the body is regenerated. */
  testCounts?: TestCounts;
}

export const defaultBlockData = (name: string): FunctionBlockData => ({
  name,
  signature: '(input: unknown) => unknown',
  mode: 'SDD',
  spec: '',
  tests: '',
  scope: [],
  body: '',
  status: 'stub',
  language: '',
});
