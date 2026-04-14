export type DevMode = 'TDD' | 'SDD' | 'manual';

export type BlockStatus =
  | 'stub'
  | 'specd'
  | 'generating'
  | 'running_tests'
  | 'passing'
  | 'failing';

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
