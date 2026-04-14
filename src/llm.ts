import Anthropic from '@anthropic-ai/sdk';
import { DevMode, FunctionBlockData } from './types';

interface NeighborSignature {
  name: string;
  signature: string;
  direction: 'upstream' | 'downstream';
}

export interface GenerateInput {
  block: FunctionBlockData;
  neighbors: NeighborSignature[];
  language: string;
  previousAttempt?: {
    body: string;
    failures: Array<{ name: string; error: string }>;
  };
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface GenerateCallbacks {
  onDelta: (text: string) => void;
  onDone: (final: { fullText: string; body: string; usage?: TokenUsage }) => void;
  onError: (err: Error) => void;
}

function buildSystemPrompt(language: string, mode: DevMode): string {
  // TDD bodies execute in a JS sandbox regardless of the block's declared language,
  // so the "expert X" opener must match what we actually run.
  const effLang = mode === 'TDD' ? 'JavaScript' : language;

  const tddNote =
    mode === 'TDD'
      ? `

The body will execute inside a plain JavaScript Web Worker sandbox to validate the tests. Output VALID JAVASCRIPT SYNTAX ONLY — no TypeScript type annotations, no \`as\`/\`satisfies\`/enum/namespace, no type-only imports. Parameter names are taken from the signature; types shown in the signature are ignored at runtime.`
      : '';

  return `You are an expert ${effLang} developer collaborating on a visual function-block graph.

Each block is a single function. You are given:
- The function signature (do not change it)
- A development mode: SDD (spec-driven), TDD (test-driven), or manual (free-form)
- A natural-language spec (SDD) or test cases (TDD)
- Signatures of upstream/downstream neighbor blocks for context

Your job is to write the function BODY only — the code between the braces (or the equivalent indented suite in Python). Do NOT output the function signature, imports, type declarations, module scaffolding, or explanations. Output ONE fenced code block containing just the body, nothing else.

Rules:
- Assume the signature is fixed and correct
- Prefer simple, direct code over cleverness
- Do not add comments unless they explain a non-obvious invariant
- If inputs are invalid, throw/raise rather than returning sentinel values
- You may call neighbor functions by name when their signatures are listed
- Never invent external dependencies that aren't obviously standard library${tddNote}`;
}

export function buildUserPrompt(input: GenerateInput): string {
  const { block, neighbors } = input;
  const parts: string[] = [];

  parts.push(`Function name: ${block.name}`);
  parts.push(`Signature: ${block.signature}`);
  parts.push(`Mode: ${block.mode}`);

  if (block.mode === 'SDD') {
    parts.push('', 'Spec:', block.spec || '(no spec provided — infer intent from the name and signature)');
  } else if (block.mode === 'TDD') {
    parts.push('', 'Tests this body must pass:', block.tests || '(no tests provided — infer intent from the name and signature)');
  } else {
    parts.push('', 'Free-form instructions:', block.spec || '(no instructions — infer intent from the name and signature)');
  }

  if (neighbors.length > 0) {
    parts.push('', 'Neighbor functions you can call:');
    for (const n of neighbors) {
      parts.push(`  [${n.direction}] ${n.name}: ${n.signature}`);
    }
  }

  if (block.scope.length > 0) {
    parts.push(
      '',
      'Scope constraints — this block is restricted to these file globs:',
    );
    for (const g of block.scope) parts.push(`  - ${g}`);
    parts.push(
      'Only use identifiers from the standard library, the neighbor functions listed above, or things declared inside these globs. Do NOT import from paths outside this scope.',
    );
  }

  if (input.previousAttempt) {
    parts.push('', 'Your previous attempt (which FAILED the tests below):');
    parts.push('```', input.previousAttempt.body, '```');
    parts.push('', 'Failing tests from that attempt:');
    for (const f of input.previousAttempt.failures) {
      parts.push(`- ${f.name}: ${f.error}`);
    }
    parts.push('', 'Analyze what went wrong and produce a corrected body. Do not repeat the same mistake. Do not change the signature.');
  }

  parts.push('', 'Output the function body as a single fenced code block. No prose before or after.');

  return parts.join('\n');
}

function dedent(text: string): string {
  const lines = text.split('\n');
  const indents = lines
    .filter((l) => l.trim().length > 0)
    .map((l) => l.match(/^[ \t]*/)?.[0].length ?? 0);
  if (indents.length === 0) return text;
  const minIndent = Math.min(...indents);
  if (minIndent === 0) return text;
  return lines.map((l) => l.slice(minIndent)).join('\n');
}

/**
 * Advance from `i` past a balanced pair opened by `code[i]`, where `code[i]`
 * is one of `(`, `{`, `[`. Returns the index AFTER the closing character, or
 * -1 if the bracket is unmatched. Skips string literals so brackets inside
 * `"a(b)"` don't affect depth.
 */
function skipBalanced(code: string, i: number): number {
  const open = code[i];
  const close = open === '(' ? ')' : open === '{' ? '}' : open === '[' ? ']' : '';
  if (!close) return -1;
  let depth = 1;
  let inString: false | string = false;
  i++;
  while (i < code.length && depth > 0) {
    const ch = code[i];
    if (inString) {
      if (ch === '\\' && i + 1 < code.length) { i += 2; continue; }
      if (ch === inString) inString = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; i++; continue; }
    if (ch === open) depth++;
    else if (ch === close) depth--;
    i++;
  }
  return depth === 0 ? i : -1;
}

/**
 * If `code` is a single JavaScript function declaration — either
 * `function name(...) { body }` or `const name = (...) => { body }` —
 * return just the body. Otherwise return null. Bracket-balanced so nested
 * parens/braces in parameter types and bodies don't break the unwrap.
 */
function unwrapJsFunction(code: string): string | null {
  // Match `function NAME` prefix
  const fnMatch = code.match(/^function\s+\w+\s*/);
  const arrowMatch = code.match(
    /^(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?/,
  );
  let i: number;
  let kind: 'decl' | 'arrow';
  if (fnMatch) {
    i = fnMatch[0].length;
    kind = 'decl';
  } else if (arrowMatch) {
    i = arrowMatch[0].length;
    kind = 'arrow';
  } else {
    return null;
  }

  if (code[i] !== '(') return null;
  const afterParams = skipBalanced(code, i);
  if (afterParams < 0) return null;
  i = afterParams;

  // Skip whitespace + arrow if needed
  while (i < code.length && /\s/.test(code[i])) i++;
  if (kind === 'arrow') {
    if (code[i] === '=' && code[i + 1] === '>') {
      i += 2;
      while (i < code.length && /\s/.test(code[i])) i++;
    } else {
      return null;
    }
  }

  if (code[i] !== '{') return null;
  const afterBody = skipBalanced(code, i);
  if (afterBody < 0) return null;
  const body = code.slice(i + 1, afterBody - 1);

  // Whatever's left must be whitespace or a trailing semicolon only.
  const rest = code.slice(afterBody).trim();
  if (rest.length > 0 && rest !== ';') return null;

  return body.trim();
}

export function extractCodeBlock(full: string): string {
  const fence = /```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/;
  const match = full.match(fence);
  const code = (match ? match[1] : full).trim();

  // JS function / arrow function unwrap (bracket-balanced)
  const jsBody = unwrapJsFunction(code);
  if (jsBody !== null) return jsBody;

  // Unwrap: `def name(...)[ -> T]:\n    body` → body (dedented)
  const pyDef = code.match(
    /^(?:async\s+)?def\s+\w+\s*\([^)]*\)\s*(?:->\s*[^:\n]+)?\s*:\s*\n([\s\S]*)$/,
  );
  if (pyDef) return dedent(pyDef[1].trimEnd());

  return code;
}

// Cache one Anthropic client per key so we don't rebuild it on every generate.
let cachedClient: { key: string; client: Anthropic } | null = null;
function getClient(apiKey: string): Anthropic {
  if (!cachedClient || cachedClient.key !== apiKey) {
    cachedClient = {
      key: apiKey,
      client: new Anthropic({ apiKey, dangerouslyAllowBrowser: true }),
    };
  }
  return cachedClient.client;
}

export interface GenerateHandle {
  abort: () => void;
  /** True after abort() was called, so callers can distinguish user-cancel from API errors. */
  readonly aborted: boolean;
}

export function generateBody(
  apiKey: string,
  model: string,
  input: GenerateInput,
  cb: GenerateCallbacks,
): GenerateHandle {
  if (!apiKey) {
    cb.onError(new Error('Missing API key — open Settings and paste your Anthropic API key.'));
    return { abort: () => {}, aborted: false };
  }

  const client = getClient(apiKey);

  const system: Anthropic.TextBlockParam[] = [
    {
      type: 'text',
      text: buildSystemPrompt(input.language, input.block.mode),
      cache_control: { type: 'ephemeral' },
    },
  ];

  const stream = client.messages.stream({
    model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system,
    messages: [
      { role: 'user', content: buildUserPrompt(input) },
    ],
  });

  let fullText = '';
  const state = { aborted: false };

  stream.on('text', (delta) => {
    fullText += delta;
    cb.onDelta(delta);
  });

  stream
    .finalMessage()
    .then((final) => {
      if (state.aborted) return;
      const body = extractCodeBlock(fullText);
      const usage: TokenUsage | undefined = final.usage
        ? {
            input_tokens: final.usage.input_tokens,
            output_tokens: final.usage.output_tokens,
            cache_read_input_tokens: final.usage.cache_read_input_tokens ?? undefined,
            cache_creation_input_tokens: final.usage.cache_creation_input_tokens ?? undefined,
          }
        : undefined;
      cb.onDone({ fullText, body, usage });
    })
    .catch((err: unknown) => {
      if (state.aborted) return;
      cb.onError(err instanceof Error ? err : new Error(String(err)));
    });

  return {
    abort: () => {
      state.aborted = true;
      stream.abort();
    },
    get aborted() { return state.aborted; },
  };
}

export interface GenerateAsyncHandle {
  promise: Promise<string>;
  abort: () => void;
  handle: GenerateHandle;
}

export function generateBodyAsync(
  apiKey: string,
  model: string,
  input: GenerateInput,
  onDelta: (text: string) => void,
): GenerateAsyncHandle {
  let handle!: GenerateHandle;
  let rejectFn!: (err: Error) => void;
  const promise = new Promise<string>((resolve, reject) => {
    rejectFn = reject;
    handle = generateBody(apiKey, model, input, {
      onDelta,
      onDone: ({ body }) => resolve(body),
      onError: (err) => reject(err),
    });
  });
  return {
    promise,
    // generateBody.abort() flips state.aborted so onDone/onError are swallowed,
    // which would leave this promise hanging. Explicitly reject so callers can unblock.
    abort: () => {
      handle.abort();
      rejectFn(new Error('aborted by user'));
    },
    handle,
  };
}
