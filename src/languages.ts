export interface LanguageDef {
  id: string;
  label: string;
  sampleSignature: string;
}

export const LANGUAGES: LanguageDef[] = [
  { id: 'typescript', label: 'TypeScript', sampleSignature: '(input: unknown) => unknown' },
  { id: 'javascript', label: 'JavaScript', sampleSignature: '(input) => unknown' },
  { id: 'python',     label: 'Python',     sampleSignature: 'def f(x): ...' },
  { id: 'c',          label: 'C',          sampleSignature: 'int f(int x)' },
  { id: 'cpp',        label: 'C++',        sampleSignature: 'auto f(int x) -> int' },
  { id: 'go',         label: 'Go',         sampleSignature: 'func f(x int) int' },
  { id: 'rust',       label: 'Rust',       sampleSignature: 'fn f(x: i32) -> i32' },
  { id: 'java',       label: 'Java',       sampleSignature: 'int f(int x)' },
];

export function labelFor(id: string): string {
  return LANGUAGES.find((l) => l.id === id)?.label ?? id;
}
