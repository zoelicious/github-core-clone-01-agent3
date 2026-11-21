// GraphQL: a small, purpose-built executor for the documents the gh CLI and
// github-mcp-server send (viewer, repository, issue and pull-request queries,
// the create/close/merge mutations, node lookups and __type introspection).
// It is not a general GraphQL server: it parses the exact grammar those
// documents use (operations, variables, inline fragments, aliases, enums,
// lists and input objects) and resolves them against the same ForgeStore the
// REST and git layers use.
//
// Unknown fields answer HTTP 200 with an errors array naming the field
// (GraphQL semantics: the field resolves to null, its siblings still run);
// an unknown repository answers data.repository = null with no errors.

import {
  ForgeStore,
  decodeGlobalId,
  globalId,
  type IssueRecord,
  type PullRecord,
  type RepoRecord,
} from './store.ts';
import { createIssueRecord as createIssue, createPullRecord as createPull, mergeWouldConflict } from './rest.ts';

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$![]=|&@'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
          continue;
        }
        out += source[j];
        j += 1;
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      const raw = source.slice(i, j);
      tokens.push(raw.includes('.') || raw.includes('e') || raw.includes('E') ? { kind: 'float', value: raw } : { kind: 'int', value: raw });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// parser (AST)
// ---------------------------------------------------------------------------

export type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

export interface FieldNode {
  alias?: string;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selection?: SelectionNode[];
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeCondition: string; selection: SelectionNode[] };

export interface OperationNode {
  operation: 'query' | 'mutation';
  name?: string;
  variables: Array<{ name: string; defaultValue?: Value }>;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value}, got ${token.kind}:${token.value}`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected name, got ${token.kind}:${token.value}`);
    return token.value;
  }

  private skipType(): void {
    // A variable type: Name, [Name], Name!, [Name!]! and so on; consume tokens
    // until the next ')' or '=' at this level.
    let depth = 0;
    while (true) {
      const token = this.peek();
      if (!token) return;
      if (token.kind === 'punct' && token.value === '[') depth += 1;
      if (token.kind === 'punct' && token.value === ']') depth -= 1;
      if (depth === 0 && token.kind === 'punct' && (token.value === ')' || token.value === '=')) return;
      this.next();
    }
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      this.next();
      operation = token.value;
      const maybeName = this.peek();
      if (maybeName?.kind === 'name') {
        name = this.next().value;
      }
    } else if (token?.kind === 'punct' && token.value === '{') {
      // Shorthand query.
    } else {
      throw new Error('expected an operation');
    }
    const variables: Array<{ name: string; defaultValue?: Value }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.skipType();
        let defaultValue: Value | undefined;
        if (this.peek()?.kind === 'punct' && this.peek()!.value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: varName, defaultValue });
      }
      this.expectPunct(')');
    }
    const selection = this.parseSelectionSet();
    return { operation, name, variables, selection };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const selection = this.parseSelectionSet();
        return { kind: 'fragment', typeCondition, selection };
      }
      // A named fragment spread: not used by the suite's documents.
      this.expectName();
      return { kind: 'fragment', typeCondition: '', selection: [] };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: Value }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives (@include/@skip) are not used by the suite; skip them.
    while (this.peek()?.kind === 'punct' && this.peek()!.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    let selection: SelectionNode[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', field: { alias, name, args, selection } };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${token.kind}:${token.value}`);
  }
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

type GqlValue = string | number | boolean | null | Record<string, unknown> | unknown[];

interface Ctx {
  store: ForgeStore;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function resolveValue(value: Value, ctx: Ctx): unknown {
  switch (value.kind) {
    case 'variable': {
      const found = ctx.variables[value.name];
      return found === undefined ? null : found;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((item) => resolveValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, ctx);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, ctx: Ctx): unknown {
  const arg = field.args.find((item) => item.name === name);
  return arg === undefined ? undefined : resolveValue(arg.value, ctx);
}

function fieldError(ctx: Ctx, typeName: string, fieldName: string): void {
  ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
}

// The schema: which fields each type exposes (used for __type and for the
// unknown-field error path).
const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__schema', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'description',
    'isPrivate', 'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRef', 'baseRef',
    'mergeable', 'merged', 'mergeCommit', 'files', 'url', 'createdAt', 'updatedAt', 'author',
  ],
  Ref: ['name', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Label: ['name', 'color', 'description'],
  CommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Comment: ['id', 'body', 'author', 'createdAt'],
  Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields'],
  Schema: ['queryType', 'mutationType', 'types', 'directives'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'MILESTONE'];

type NodeObject =
  | { __type: 'Query' }
  | { __type: 'Mutation' }
  | { __type: 'User'; login: string }
  | { __type: 'Repository'; repo: RepoRecord }
  | { __type: 'Issue'; repo: RepoRecord; issue: IssueRecord }
  | { __type: 'PullRequest'; repo: RepoRecord; pull: PullRecord }
  | { __type: 'Ref'; name: string; oid: string }
  | { __type: 'IssueConnection'; repo: RepoRecord; items: IssueRecord[]; page: IssueRecord[]; hasNext: boolean }
  | { __type: 'PullRequestConnection'; repo: RepoRecord; items: PullRecord[]; page: PullRecord[]; hasNext: boolean }
  | { __type: 'PullRequestFileConnection'; files: Array<{ path: string; additions: number; deletions: number; changeType: string }> }
  | { __type: 'LabelConnection'; repo: RepoRecord }
  | { __type: 'CommentConnection'; repo: RepoRecord; issue: IssueRecord }
  | { __type: 'Type'; name: string }
  | { __type: 'Schema' }
  | { __type: 'Payload'; kind: string; data: Record<string, unknown> }
  | { __type: 'CommentEdge'; repo: RepoRecord; comment: { id: number; nodeId: string; body: string } };

function typeNameOf(node: NodeObject): string {
  switch (node.__type) {
    case 'Query': return 'Query';
    case 'Mutation': return 'Mutation';
    case 'User': return 'User';
    case 'Repository': return 'Repository';
    case 'Issue': return 'Issue';
    case 'PullRequest': return 'PullRequest';
    case 'Ref': return 'Ref';
    case 'IssueConnection': return 'IssueConnection';
    case 'PullRequestConnection': return 'PullRequestConnection';
    case 'PullRequestFileConnection': return 'PullRequestFileConnection';
    case 'LabelConnection': return 'LabelConnection';
    case 'CommentConnection': return 'CommentConnection';
    case 'Type': return '__Type';
    case 'Schema': return '__Schema';
    case 'Payload': return `${node.kind}Payload`;
    case 'CommentEdge': return 'CommentEdge';
  }
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function executeSelections(node: NodeObject, selections: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition === '' || selection.typeCondition === typeNameOf(node)) {
        Object.assign(out, executeSelections(node, selection.selection, ctx));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    out[key] = executeField(node, field, ctx);
  }
  return out;
}

function executeField(node: NodeObject, field: FieldNode, ctx: Ctx): unknown {
  const store = ctx.store;
  const typeName = typeNameOf(node);
  // Introspection nodes are named __Type/__Schema at runtime but 'Type'/'Schema'
  // in the schema map: normalise before the known-field lookup, or every
  // __type field (fields, enumValues, ...) reads as unknown.
  const schemaKey = typeName === '__Type' ? 'Type' : typeName === '__Schema' ? 'Schema' : typeName;
  const known = SCHEMA_FIELDS[schemaKey] ?? [];
  const isIntrospection = field.name === '__typename' || field.name === '__schema' || field.name === '__type';
  if (!isIntrospection && !known.includes(field.name)) {
    fieldError(ctx, typeName, field.name);
    return null;
  }
  const sub = (value: NodeObject | null): unknown => {
    if (value === null) return null;
    if (!field.selection) return value;
    return executeSelections(value, field.selection, ctx);
  };
  const scalar = (value: unknown): unknown => value;

  switch (node.__type) {
    case 'Query': {
      if (field.name === '__typename') return 'Query';
      if (field.name === '__schema') return sub({ __type: 'Schema' });
      if (field.name === '__type') {
        const name = argValue(field, 'name', ctx);
        return typeof name === 'string' && (SCHEMA_FIELDS[name] !== undefined || name === 'SearchType')
          ? sub({ __type: 'Type', name })
          : null;
      }
      if (field.name === 'viewer') {
        return sub({ __type: 'User', login: store.viewerLogin ?? '' });
      }
      if (field.name === 'repository') {
        const owner = String(argValue(field, 'owner', ctx) ?? '');
        const name = String(argValue(field, 'name', ctx) ?? '');
        const repo = store.getRepo(owner, name);
        if (!repo) return null;
        store.learnViewer(owner);
        return sub({ __type: 'Repository', repo });
      }
      if (field.name === 'node') {
        const id = String(argValue(field, 'id', ctx) ?? '');
        const decoded = decodeGlobalId(id);
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = store.getRepo(decoded.owner, decoded.name);
          return repo ? sub({ __type: 'Repository', repo }) : null;
        }
        if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
          const repo = store.getRepo(decoded.owner, decoded.name);
          if (!repo || decoded.number === null) return null;
          if (decoded.kind === 'Issue') {
            const issue = repo.issues.find((item) => item.number === decoded.number);
            return issue ? sub({ __type: 'Issue', repo, issue }) : null;
          }
          const pull = repo.pulls.find((item) => item.number === decoded.number);
          return pull ? sub({ __type: 'PullRequest', repo, pull }) : null;
        }
        return null;
      }
      return null;
    }
    case 'Mutation': {
      if (field.name === '__typename') return 'Mutation';
      if (field.name === 'createIssue') return mutateCreateIssue(node, field, ctx);
      if (field.name === 'closeIssue') return mutateCloseIssue(node, field, ctx);
      if (field.name === 'createPullRequest') return mutateCreatePullRequest(node, field, ctx);
      if (field.name === 'mergePullRequest') return mutateMergePullRequest(node, field, ctx);
      if (field.name === 'addComment') return mutateAddComment(node, field, ctx);
      return null;
    }
    case 'User': {
      if (field.name === '__typename') return 'User';
      if (field.name === 'login' || field.name === 'name') return scalar(node.login);
      if (field.name === 'id') return scalar(1);
      if (field.name === 'url') return scalar('');
      return null;
    }
    case 'Repository': {
      const repo = node.repo;
      const owner = repo.owner ?? store.viewerLogin ?? '';
      if (field.name === '__typename') return 'Repository';
      if (field.name === 'id') return scalar(globalId('Repository', owner, repo.name));
      if (field.name === 'databaseId') return scalar(repo.databaseId);
      if (field.name === 'name') return scalar(repo.name);
      if (field.name === 'nameWithOwner') return scalar(`${owner}/${repo.name}`);
      if (field.name === 'description') return scalar(repo.description);
      if (field.name === 'isPrivate') return scalar(repo.private);
      if (field.name === 'url') return scalar('');
      if (field.name === 'createdAt' || field.name === 'updatedAt') return scalar('2025-01-01T00:00:00Z');
      if (field.name === 'owner') return sub({ __type: 'User', login: owner });
      if (field.name === 'defaultBranchRef') {
        return sub({ __type: 'Ref', name: repo.defaultBranch, oid: store.defaultTip(repo) ?? '0'.repeat(40) });
      }
      if (field.name === 'viewerPermission') return scalar('ADMIN');
      if (field.name === 'hasIssuesEnabled') return scalar(true);
      if (field.name === 'issue') {
        const number = Number(argValue(field, 'number', ctx) ?? -1);
        const issue = repo.issues.find((item) => item.number === number);
        return issue ? sub({ __type: 'Issue', repo, issue }) : null;
      }
      if (field.name === 'issues') return issuesConnection(store, repo, field, ctx, sub);
      if (field.name === 'pullRequest') {
        const number = Number(argValue(field, 'number', ctx) ?? -1);
        const pull = repo.pulls.find((item) => item.number === number);
        return pull ? sub({ __type: 'PullRequest', repo, pull }) : null;
      }
      if (field.name === 'pullRequests') return pullsConnection(store, repo, field, ctx, sub);
      return null;
    }
    case 'Issue': {
      const issue = node.issue;
      if (field.name === '__typename') return 'Issue';
      if (field.name === 'id') return scalar(issue.nodeId);
      if (field.name === 'number') return scalar(issue.number);
      if (field.name === 'title') return scalar(issue.title);
      if (field.name === 'body') return scalar(issue.body);
      if (field.name === 'state') return scalar(issue.state === 'open' ? 'OPEN' : 'CLOSED');
      if (field.name === 'url') return scalar('');
      if (field.name === 'createdAt' || field.name === 'updatedAt') return scalar('2025-01-01T00:00:00Z');
      if (field.name === 'author') {
        return sub({ __type: 'User', login: node.repo.owner ?? store.viewerLogin ?? '' });
      }
      if (field.name === 'labels') return sub({ __type: 'LabelConnection', repo: node.repo });
      if (field.name === 'comments') return sub({ __type: 'CommentConnection', repo: node.repo, issue });
      return null;
    }
    case 'PullRequest': {
      const pull = node.pull;
      const repo = node.repo;
      if (field.name === '__typename') return 'PullRequest';
      if (field.name === 'id') return scalar(pull.nodeId);
      if (field.name === 'number') return scalar(pull.number);
      if (field.name === 'title') return scalar(pull.title);
      if (field.name === 'body') return scalar(pull.body);
      if (field.name === 'state') {
        return scalar(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED');
      }
      if (field.name === 'headRefName') return scalar(pull.headRef);
      if (field.name === 'baseRefName') return scalar(pull.baseRef);
      if (field.name === 'headRef') return sub({ __type: 'Ref', name: pull.headRef, oid: pull.headSha });
      if (field.name === 'baseRef') return sub({ __type: 'Ref', name: pull.baseRef, oid: pull.baseSha });
      if (field.name === 'mergeable') {
        if (pull.merged || pull.state !== 'open') return scalar('UNKNOWN');
        return scalar(mergeWouldConflict(store, repo, pull) ? 'CONFLICTING' : 'MERGEABLE');
      }
      if (field.name === 'merged') return scalar(pull.merged);
      if (field.name === 'mergeCommit') {
        return pull.mergeCommitSha
          ? sub({ __type: 'Ref', name: pull.baseRef, oid: pull.mergeCommitSha })
          : null;
      }
      if (field.name === 'url') return scalar('');
      if (field.name === 'createdAt' || field.name === 'updatedAt') return scalar('2025-01-01T00:00:00Z');
      if (field.name === 'author') {
        return sub({ __type: 'User', login: repo.owner ?? store.viewerLogin ?? '' });
      }
      if (field.name === 'files') {
        const baseInfo = store.commitInfo(store.peelToCommit(pull.baseSha));
        const headInfo = store.commitInfo(store.peelToCommit(pull.headSha));
        if (!baseInfo || !headInfo) return sub({ __type: 'PullRequestFileConnection', files: [] });
        const files = store.diffFiles(baseInfo.tree, headInfo.tree).map((file) => ({
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
        }));
        return sub({ __type: 'PullRequestFileConnection', files });
      }
      return null;
    }
    case 'Ref': {
      if (field.name === '__typename') return 'Ref';
      if (field.name === 'name') return scalar(node.name);
      if (field.name === 'target') return scalar({ oid: node.oid });
      return null;
    }
    case 'IssueConnection':
    case 'PullRequestConnection': {
      const isIssue = node.__type === 'IssueConnection';
      if (field.name === '__typename') return isIssue ? 'IssueConnection' : 'PullRequestConnection';
      if (field.name === 'totalCount') return scalar(node.items.length);
      if (field.name === 'nodes') {
        return node.page.map((item) =>
          field.selection
            ? executeSelections(
                isIssue
                  ? { __type: 'Issue', repo: node.repo, issue: item as IssueRecord }
                  : { __type: 'PullRequest', repo: node.repo, pull: item as PullRecord },
                field.selection,
                ctx,
              )
            : item,
        );
      }
      if (field.name === 'edges') {
        return node.page.map((item) => {
          const edgeNode: NodeObject = isIssue
            ? { __type: 'Issue', repo: node.repo, issue: item as IssueRecord }
            : { __type: 'PullRequest', repo: node.repo, pull: item as PullRecord };
          if (!field.selection) return { node: edgeNode, cursor: cursorFor(item.number) };
          const out: Record<string, unknown> = {};
          for (const selection of field.selection) {
            if (selection.kind === 'field' && selection.field.name === 'node') {
              out['node'] = selection.field.selection
                ? executeSelections(edgeNode, selection.field.selection, ctx)
                : edgeNode;
            } else if (selection.kind === 'field' && selection.field.name === 'cursor') {
              out['cursor'] = cursorFor(item.number);
            }
          }
          return out;
        });
      }
      if (field.name === 'pageInfo') {
        const info = {
          hasNextPage: node.hasNext,
          hasPreviousPage: false,
          startCursor: node.page.length > 0 ? cursorFor(node.page[0]!.number) : null,
          endCursor: node.page.length > 0 ? cursorFor(node.page[node.page.length - 1]!.number) : null,
        };
        if (!field.selection) return info;
        const out: Record<string, unknown> = {};
        for (const selection of field.selection) {
          if (selection.kind === 'field') out[selection.field.alias ?? selection.field.name] = info[selection.field.name as keyof typeof info] ?? null;
        }
        return out;
      }
      return null;
    }
    case 'PullRequestFileConnection': {
      if (field.name === '__typename') return 'PullRequestFileConnection';
      if (field.name === 'totalCount') return scalar(node.files.length);
      if (field.name === 'nodes') {
        return node.files.map((file) => {
          if (!field.selection) return file;
          const out: Record<string, unknown> = {};
          for (const selection of field.selection) {
            if (selection.kind === 'field') {
              const name = selection.field.name;
              out[selection.field.alias ?? name] =
                name === 'path' ? file.path : name === 'additions' ? file.additions : name === 'deletions' ? file.deletions : name === 'changeType' ? file.changeType : null;
            }
          }
          return out;
        });
      }
      if (field.name === 'edges') {
        return node.files.map((file, index) => {
          if (!field.selection) return { node: file, cursor: cursorFor(index + 1) };
          const out: Record<string, unknown> = {};
          for (const selection of field.selection) {
            if (selection.kind === 'field' && selection.field.name === 'node') {
              const nodeOut: Record<string, unknown> = {};
              for (const inner of selection.field.selection ?? []) {
                if (inner.kind === 'field') {
                  const name = inner.field.name;
                  nodeOut[inner.field.alias ?? name] =
                    name === 'path' ? file.path : name === 'additions' ? file.additions : name === 'deletions' ? file.deletions : name === 'changeType' ? file.changeType : null;
                }
              }
              out['node'] = nodeOut;
            } else if (selection.kind === 'field' && selection.field.name === 'cursor') {
              out['cursor'] = cursorFor(index + 1);
            }
          }
          return out;
        });
      }
      if (field.name === 'pageInfo') {
        return {
          hasNextPage: false,
          hasPreviousPage: false,
          startCursor: node.files.length > 0 ? cursorFor(1) : null,
          endCursor: node.files.length > 0 ? cursorFor(node.files.length) : null,
        };
      }
      return null;
    }
    case 'LabelConnection': {
      if (field.name === '__typename') return 'LabelConnection';
      if (field.name === 'totalCount') return scalar(node.repo.labels.size);
      if (field.name === 'nodes') {
        return [...node.repo.labels.values()].map((label) => {
          if (!field.selection) return { name: label.name, color: label.color };
          const out: Record<string, unknown> = {};
          for (const selection of field.selection) {
            if (selection.kind === 'field') {
              const name = selection.field.name;
              out[selection.field.alias ?? name] =
                name === 'name' ? label.name : name === 'color' ? label.color : name === 'description' ? '' : null;
            }
          }
          return out;
        });
      }
      return null;
    }
    case 'CommentConnection': {
      if (field.name === '__typename') return 'CommentConnection';
      if (field.name === 'totalCount') return scalar(node.issue.comments.length);
      if (field.name === 'nodes') {
        return node.issue.comments.map((comment) => {
          if (!field.selection) return { id: comment.nodeId, body: comment.body };
          const out: Record<string, unknown> = {};
          for (const selection of field.selection) {
            if (selection.kind === 'field') {
              const name = selection.field.name;
              out[selection.field.alias ?? name] =
                name === 'id' ? comment.nodeId : name === 'body' ? comment.body : null;
            }
          }
          return out;
        });
      }
      return null;
    }
    case 'Type': {
      if (field.name === '__typename') return '__Type';
      if (field.name === 'name') return scalar(node.name);
      if (field.name === 'kind') return scalar(node.name === 'SearchType' ? 'ENUM' : 'OBJECT');
      if (field.name === 'description') return scalar(null);
      if (field.name === 'fields') {
        const names = SCHEMA_FIELDS[node.name] ?? [];
        return names.map((name) => ({
          name,
          description: null,
          args: [],
          type: { name: 'String', kind: 'SCALAR' },
          isDeprecated: false,
          deprecationReason: null,
        }));
      }
      if (field.name === 'enumValues') {
        if (node.name !== 'SearchType') return null;
        return SEARCH_TYPE_VALUES.map((name) => ({ name, description: null, isDeprecated: false, deprecationReason: null }));
      }
      if (field.name === 'inputFields') return null;
      return null;
    }
    case 'Schema': {
      if (field.name === '__typename') return '__Schema';
      if (field.name === 'queryType') return scalar({ name: 'Query' });
      if (field.name === 'mutationType') return scalar({ name: 'Mutation' });
      if (field.name === 'types') {
        return [...Object.keys(SCHEMA_FIELDS), 'SearchType'].map((name) => ({ name, kind: name === 'SearchType' ? 'ENUM' : 'OBJECT' }));
      }
      if (field.name === 'directives') return scalar([]);
      return null;
    }
    case 'Payload': {
      if (field.name === '__typename') return typeNameOf(node);
      if (field.name === 'clientMutationId') return scalar(node.data['clientMutationId'] ?? null);
      const value = node.data[field.name];
      if (value === undefined) return null;
      if (value !== null && typeof value === 'object' && '__node' in (value as Record<string, unknown>)) {
        return sub((value as { __node: NodeObject }).__node);
      }
      return scalar(value);
    }
    case 'CommentEdge': {
      if (field.name === '__typename') return 'CommentEdge';
      if (field.name === 'cursor') return scalar(cursorFor(node.comment.id));
      if (field.name === 'node') {
        if (!field.selection) return { id: node.comment.nodeId, body: node.comment.body };
        const out: Record<string, unknown> = {};
        for (const selection of field.selection) {
          if (selection.kind === 'field') {
            const name = selection.field.name;
            out[selection.field.alias ?? name] =
              name === 'id' ? node.comment.nodeId : name === 'body' ? node.comment.body : null;
          }
        }
        return out;
      }
      return null;
    }
  }
}

function issuesConnection(
  store: ForgeStore,
  repo: RepoRecord,
  field: FieldNode,
  ctx: Ctx,
  sub: (value: NodeObject | null) => unknown,
): unknown {
  const states = argValue(field, 'states', ctx) as string[] | undefined;
  const orderBy = argValue(field, 'orderBy', ctx) as Record<string, unknown> | undefined;
  const first = Number(argValue(field, 'first', ctx) ?? 100);
  const after = argValue(field, 'after', ctx);
  let items = [...repo.issues];
  if (states && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    items = items.filter((issue) => wanted.has(issue.state));
  }
  const direction = String(orderBy?.['direction'] ?? 'DESC');
  items.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const afterNumber = cursorNumber(after);
  if (afterNumber !== null) {
    const index = items.findIndex((issue) => issue.number === afterNumber);
    if (index >= 0) items = items.slice(index + 1);
  }
  const page = items.slice(0, first);
  const hasNext = items.length > first;
  return sub({ __type: 'IssueConnection', repo, items, page, hasNext });
}

function pullsConnection(
  store: ForgeStore,
  repo: RepoRecord,
  field: FieldNode,
  ctx: Ctx,
  sub: (value: NodeObject | null) => unknown,
): unknown {
  const states = argValue(field, 'states', ctx) as string[] | undefined;
  const orderBy = argValue(field, 'orderBy', ctx) as Record<string, unknown> | undefined;
  const first = Number(argValue(field, 'first', ctx) ?? 100);
  const after = argValue(field, 'after', ctx);
  let items = [...repo.pulls];
  if (states && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    items = items.filter((pull) => {
      const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
      return wanted.has(state);
    });
  }
  const direction = String(orderBy?.['direction'] ?? 'DESC');
  items.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const afterNumber = cursorNumber(after);
  if (afterNumber !== null) {
    const index = items.findIndex((pull) => pull.number === afterNumber);
    if (index >= 0) items = items.slice(index + 1);
  }
  const page = items.slice(0, first);
  const hasNext = items.length > first;
  return sub({ __type: 'PullRequestConnection', repo, items, page, hasNext });
}

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------

function inputObject(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const value = argValue(field, 'input', ctx);
  return (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
}

function payloadResult(
  node: NodeObject,
  field: FieldNode,
  ctx: Ctx,
  kind: string,
  data: Record<string, unknown>,
): unknown {
  if (!field.selection) return data;
  return executeSelections({ __type: 'Payload', kind, data }, field.selection, ctx);
}

function mutateCreateIssue(node: NodeObject, field: FieldNode, ctx: Ctx): unknown {
  const store = ctx.store;
  const input = inputObject(field, ctx);
  const decoded = decodeGlobalId(String(input['repositoryId'] ?? ''));
  if (!decoded || decoded.kind !== 'Repository') {
    ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
    return null;
  }
  const repo = store.getRepo(decoded.owner, decoded.name);
  if (!repo) {
    ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
    return null;
  }
  const title = String(input['title'] ?? '');
  const record = createIssue(store, repo, { title, body: String(input['body'] ?? '') });
  repo.issues.push(record);
  return payloadResult(node, field, ctx, 'CreateIssue', {
    issue: { __node: { __type: 'Issue', repo, issue: record } },
    clientMutationId: input['clientMutationId'] ?? null,
  });
}

function mutateCloseIssue(node: NodeObject, field: FieldNode, ctx: Ctx): unknown {
  const store = ctx.store;
  const input = inputObject(field, ctx);
  const decoded = decodeGlobalId(String(input['issueId'] ?? ''));
  if (!decoded || decoded.kind !== 'Issue' || decoded.number === null) {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
    return null;
  }
  const repo = store.getRepo(decoded.owner, decoded.name);
  const issue = repo?.issues.find((item) => item.number === decoded.number);
  if (!issue || !repo) {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
    return null;
  }
  issue.state = 'closed';
  return payloadResult(node, field, ctx, 'CloseIssue', {
    issue: { __node: { __type: 'Issue', repo, issue } },
    clientMutationId: input['clientMutationId'] ?? null,
  });
}

function mutateCreatePullRequest(node: NodeObject, field: FieldNode, ctx: Ctx): unknown {
  const store = ctx.store;
  const input = inputObject(field, ctx);
  const decoded = decodeGlobalId(String(input['repositoryId'] ?? ''));
  if (!decoded || decoded.kind !== 'Repository') {
    ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
    return null;
  }
  const repo = store.getRepo(decoded.owner, decoded.name);
  if (!repo) {
    ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
    return null;
  }
  const headRef = String(input['headRefName'] ?? '');
  const baseRef = String(input['baseRefName'] ?? '');
  const owner = repo.owner ?? store.viewerLogin ?? '';
  const headTip = store.getRef(owner, repo.name, `refs/heads/${headRef}`);
  const baseTip = store.getRef(owner, repo.name, `refs/heads/${baseRef}`);
  if (headTip === undefined || baseTip === undefined) {
    ctx.errors.push({ message: `Head or base branch not found: ${headRef} / ${baseRef}` });
    return null;
  }
  const duplicate = repo.pulls.find(
    (pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef,
  );
  if (duplicate) {
    ctx.errors.push({ message: 'A pull request already exists for this head and base' });
    return null;
  }
  const record = createPull(store, repo, {
    title: String(input['title'] ?? ''),
    body: String(input['body'] ?? ''),
    headRef,
    baseRef,
    headSha: store.peelToCommit(headTip),
    baseSha: store.peelToCommit(baseTip),
  });
  repo.pulls.push(record);
  return payloadResult(node, field, ctx, 'CreatePullRequest', {
    pullRequest: { __node: { __type: 'PullRequest', repo, pull: record } },
    clientMutationId: input['clientMutationId'] ?? null,
  });
}

function mutateMergePullRequest(node: NodeObject, field: FieldNode, ctx: Ctx): unknown {
  const store = ctx.store;
  const input = inputObject(field, ctx);
  const decoded = decodeGlobalId(String(input['pullRequestId'] ?? ''));
  if (!decoded || decoded.kind !== 'PullRequest' || decoded.number === null) {
    ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
    return null;
  }
  const repo = store.getRepo(decoded.owner, decoded.name);
  const pull = repo?.pulls.find((item) => item.number === decoded.number);
  if (!pull || !repo) {
    ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
    return null;
  }
  if (pull.merged || pull.state !== 'open') {
    ctx.errors.push({ message: 'Pull request is not open' });
    return null;
  }
  if (mergeWouldConflict(store, repo, pull)) {
    ctx.errors.push({ message: 'Merge conflict' });
    return null;
  }
  const result = store.squashMerge(repo, pull);
  if ('conflict' in result) {
    ctx.errors.push({ message: 'Merge conflict' });
    return null;
  }
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = '2025-01-01T00:00:00Z';
  pull.mergeCommitSha = result.sha;
  return payloadResult(node, field, ctx, 'MergePullRequest', {
    pullRequest: { __node: { __type: 'PullRequest', repo, pull } },
    clientMutationId: input['clientMutationId'] ?? null,
  });
}

function mutateAddComment(node: NodeObject, field: FieldNode, ctx: Ctx): unknown {
  const store = ctx.store;
  const input = inputObject(field, ctx);
  const decoded = decodeGlobalId(String(input['subjectId'] ?? ''));
  if (!decoded || decoded.kind !== 'Issue' || decoded.number === null) {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
    return null;
  }
  const repo = store.getRepo(decoded.owner, decoded.name);
  const issue = repo?.issues.find((item) => item.number === decoded.number);
  if (!issue || !repo) {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
    return null;
  }
  repo.commentCounter += 1;
  const comment = {
    id: repo.commentCounter,
    nodeId: globalId('IssueComment', decoded.owner, decoded.name, repo.commentCounter),
    body: String(input['body'] ?? ''),
  };
  issue.comments.push(comment);
  return payloadResult(node, field, ctx, 'AddComment', {
    commentEdge: { __node: { __type: 'CommentEdge', repo, comment } },
    subject: { __node: { __type: 'Issue', repo, issue } },
    clientMutationId: input['clientMutationId'] ?? null,
  });
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export interface GraphqlRequest {
  headers: Record<string, string | undefined>;
  body: Buffer | undefined;
}

export interface GraphqlResponse {
  status: number;
  body: unknown;
}

export function handleGraphql(store: ForgeStore, req: GraphqlRequest): GraphqlResponse {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  if (token && req.headers['authorization'] !== `Bearer ${token}`) {
    return { status: 401, body: { message: 'Bad credentials' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse((req.body ?? Buffer.alloc(0)).toString('utf8'));
  } catch {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const results: unknown[] = [];
  for (const request of requests) {
    const query = (request as Record<string, unknown>)['query'];
    const variables = ((request as Record<string, unknown>)['variables'] ?? {}) as Record<string, unknown>;
    const operationName = (request as Record<string, unknown>)['operationName'] as string | undefined;
    if (typeof query !== 'string') {
      results.push({ errors: [{ message: 'Must provide query string.' }] });
      continue;
    }
    try {
      const operations = new Parser(tokenize(query)).parseDocument();
      const operation =
        operations.find((op) => op.name === operationName) ??
        operations.find((op) => op.name === undefined) ??
        operations[0]!;
      const ctx: Ctx = { store, variables, errors: [] };
      for (const variable of operation.variables) {
        if (ctx.variables[variable.name] === undefined && variable.defaultValue !== undefined) {
          ctx.variables[variable.name] = resolveValue(variable.defaultValue, ctx);
        }
      }
      const root: NodeObject = operation.operation === 'mutation' ? { __type: 'Mutation' } : { __type: 'Query' };
      const data = executeSelections(root, operation.selection, ctx);
      const result: Record<string, unknown> = { data };
      if (ctx.errors.length > 0) result['errors'] = ctx.errors;
      results.push(result);
    } catch (err) {
      results.push({ errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] });
    }
  }
  return { status: 200, body: Array.isArray(parsed) ? results : results[0] };
}
