// MCP: JSON-RPC 2.0 Streamable HTTP on POST /mcp, over the same ForgeStore
// as REST and git, so a repository or issue created through MCP reads back
// over /api/v3 as the same object with the same ids.
//
// Era: the server speaks revision 2026-07-28 (server/discover answers with a
// non-empty supportedVersions list) and also answers the legacy handshake
// (initialize + notifications/initialized) for 2025-11-25 and earlier.
// A malformed JSON body is HTTP 400 with JSON-RPC -32700; a missing bearer
// token is HTTP 401; an unknown tool or a missing required argument is a
// JSON-RPC error (-32602), never HTTP 500.

import { ForgeStore, globalId } from './store.ts';
import { createIssueRecord, createPullRecord, issueJson, pullJson, repoJson, resolveRepo } from './rest.ts';

// ---------------------------------------------------------------------------
// tool definitions: a frozen constant, so two tools/list calls answer the
// same list byte-for-byte. Required lists contain only properties the
// github-mcp-server client can fill.
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string }>,
  required: string[],
): ToolDef {
  return Object.freeze({
    name,
    description,
    inputSchema: Object.freeze({ type: 'object', properties: Object.freeze(properties), required: Object.freeze(required) }),
  });
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  tool(
    'create_repo',
    'Create a new repository owned by the authenticated user.',
    {
      name: { type: 'string', description: 'The name of the repository to create.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    ['name'],
  ),
  tool(
    'get_repo',
    'Get a repository by owner and name.',
    {
      owner: { type: 'string', description: 'The owner (login) of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: { type: 'string', description: 'The owner (login) of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the issue.' },
      body: { type: 'string', description: 'The body of the issue.' },
    },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'get_issue',
    'Get a single issue by owner, repository and issue number.',
    {
      owner: { type: 'string', description: 'The owner (login) of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      issue_number: { type: 'integer', description: 'The number of the issue.' },
    },
    ['owner', 'repo', 'issue_number'],
  ),
  tool(
    'list_issues',
    'List issues of a repository, optionally filtered by state.',
    {
      owner: { type: 'string', description: 'The owner (login) of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_pull_request',
    'Create a pull request from a head branch onto a base branch.',
    {
      owner: { type: 'string', description: 'The owner (login) of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the pull request.' },
      head: { type: 'string', description: 'The head branch (with the changes).' },
      base: { type: 'string', description: 'The base branch (to merge into).' },
      body: { type: 'string', description: 'The body of the pull request.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'list_pull_requests',
    'List pull requests of a repository, optionally filtered by state.',
    {
      owner: { type: 'string', description: 'The owner (login) of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      state: { type: 'string', description: 'Pull request state filter: open, closed or all.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'merge_pull_request',
    'Squash-merge a pull request onto its base branch.',
    {
      owner: { type: 'string', description: 'The owner (login) of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      pull_number: { type: 'integer', description: 'The number of the pull request.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
]);

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = Object.freeze({ name: 'forge-disk', version: '1.0.0' });

// ---------------------------------------------------------------------------
// argument mapping: the client fills schema properties by normalised synonyms,
// so accept the nearby names too (owner_login, head_ref, pullNumber, ...).
// ---------------------------------------------------------------------------

function pickArg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value);
  return undefined;
}

// ---------------------------------------------------------------------------
// tool execution
// ---------------------------------------------------------------------------

interface CallOutcome {
  structured: unknown;
  text: string;
}

class ToolError extends Error {}

function ownerRepoOf(args: Record<string, unknown>): { owner: string; repo: string } {
  const owner = asText(pickArg(args, 'owner', 'owner_login', 'ownerLogin'));
  const repo = asText(pickArg(args, 'repo', 'repository', 'repo_name', 'repoName'));
  if (!owner) throw new ToolError('Missing required argument: owner');
  if (!repo) throw new ToolError('Missing required argument: repo');
  return { owner, repo };
}

function executeTool(store: ForgeStore, name: string, args: Record<string, unknown>): CallOutcome {
  const normalized = name.toLowerCase().replace(/^[^a-z0-9]+/, '');
  const toolName = normalized.endsWith('create_repo') ? 'create_repo'
    : normalized.endsWith('get_repo') ? 'get_repo'
    : normalized.endsWith('create_issue') ? 'create_issue'
    : normalized.endsWith('get_issue') ? 'get_issue'
    : normalized.endsWith('list_issues') ? 'list_issues'
    : normalized.endsWith('create_pull_request') ? 'create_pull_request'
    : normalized.endsWith('list_pull_requests') ? 'list_pull_requests'
    : normalized.endsWith('merge_pull_request') ? 'merge_pull_request'
    : null;
  if (toolName === null) throw new ToolError(`Unknown tool: ${name}`);

  if (toolName === 'create_repo') {
    const repoName = asText(pickArg(args, 'name', 'repo', 'repository'));
    if (!repoName) throw new ToolError('Missing required argument: name');
    if (store.repoExists(repoName)) throw new ToolError('Repository already exists');
    const record = store.createRepo(repoName, {
      description: asText(pickArg(args, 'description')),
      private: pickArg(args, 'private') === true,
    });
    const body = repoJson(store, record);
    return { structured: body, text: JSON.stringify(body) };
  }

  const { owner, repo } = ownerRepoOf(args);
  const record = resolveRepo(store, owner, repo);
  if (!record) throw new ToolError('Repository not found');

  switch (toolName) {
    case 'get_repo': {
      const body = repoJson(store, record);
      return { structured: body, text: JSON.stringify(body) };
    }
    case 'create_issue': {
      const title = asText(pickArg(args, 'title'));
      if (!title) throw new ToolError('Missing required argument: title');
      const issue = createIssueRecord(store, record, {
        title,
        body: asText(pickArg(args, 'body', 'description')),
      });
      record.issues.push(issue);
      const body = issueJson(store, record, issue);
      return { structured: body, text: JSON.stringify(body) };
    }
    case 'get_issue': {
      const number = asNumber(pickArg(args, 'issue_number', 'issueNumber', 'number'));
      if (number === undefined) throw new ToolError('Missing required argument: issue_number');
      const issue = record.issues.find((item) => item.number === number);
      if (!issue) throw new ToolError('Issue not found');
      const body = issueJson(store, record, issue);
      return { structured: body, text: JSON.stringify(body) };
    }
    case 'list_issues': {
      const state = (asText(pickArg(args, 'state')) ?? 'open').toLowerCase();
      const issues = record.issues.filter((issue) => state === 'all' || issue.state === state);
      const body = issues.map((issue) => issueJson(store, record, issue));
      return { structured: { issues: body }, text: JSON.stringify(body) };
    }
    case 'create_pull_request': {
      const title = asText(pickArg(args, 'title'));
      const head = asText(pickArg(args, 'head', 'head_ref', 'headRef'));
      const base = asText(pickArg(args, 'base', 'base_ref', 'baseRef'));
      if (!title) throw new ToolError('Missing required argument: title');
      if (!head) throw new ToolError('Missing required argument: head');
      if (!base) throw new ToolError('Missing required argument: base');
      const viewer = record.owner ?? store.viewerLogin ?? '';
      const headTip = store.getRef(viewer, record.name, `refs/heads/${head}`);
      const baseTip = store.getRef(viewer, record.name, `refs/heads/${base}`);
      if (headTip === undefined) throw new ToolError(`head branch not found: ${head}`);
      if (baseTip === undefined) throw new ToolError(`base branch not found: ${base}`);
      const duplicate = record.pulls.find(
        (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
      );
      if (duplicate) throw new ToolError('A pull request already exists for this head and base');
      const pull = createPullRecord(store, record, {
        title,
        body: asText(pickArg(args, 'body', 'description')),
        headRef: head,
        baseRef: base,
        headSha: store.peelToCommit(headTip),
        baseSha: store.peelToCommit(baseTip),
      });
      record.pulls.push(pull);
      const body = pullJson(store, record, pull);
      return { structured: body, text: JSON.stringify(body) };
    }
    case 'list_pull_requests': {
      const state = (asText(pickArg(args, 'state')) ?? 'open').toLowerCase();
      const pulls = record.pulls.filter((pull) => state === 'all' || pull.state === state);
      const body = pulls.map((pull) => pullJson(store, record, pull));
      return { structured: { pull_requests: body }, text: JSON.stringify(body) };
    }
    case 'merge_pull_request': {
      const number = asNumber(pickArg(args, 'pull_number', 'pullNumber', 'number', 'pr_number'));
      if (number === undefined) throw new ToolError('Missing required argument: pull_number');
      const pull = record.pulls.find((item) => item.number === number);
      if (!pull) throw new ToolError('Pull request not found');
      if (pull.merged || pull.state !== 'open') throw new ToolError('Pull request is not open');
      const result = store.squashMerge(record, pull);
      if ('conflict' in result) throw new ToolError('Merge conflict');
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = '2025-01-01T00:00:00Z';
      pull.mergeCommitSha = result.sha;
      const body = { sha: result.sha, merged: true, message: `Merge pull request #${pull.number}: ${pull.title}` };
      return { structured: body, text: JSON.stringify(body) };
    }
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------

export interface McpRequest {
  headers: Record<string, string | undefined>;
  body: Buffer | undefined;
}

export interface McpResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown; // JSON value, or a Buffer sent as-is
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export function handleMcp(store: ForgeStore, req: McpRequest): McpResponse {
  // A body that is not JSON at all is a parse error before anything else.
  let parsed: unknown;
  try {
    parsed = JSON.parse((req.body ?? Buffer.alloc(0)).toString('utf8'));
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  if (token && req.headers['authorization'] !== `Bearer ${token}`) {
    return { status: 401, body: { message: 'Bad credentials' } };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const request = parsed as Record<string, unknown>;
  const id = request['id'];
  const method = request['method'];
  const isNotification = id === undefined;
  if (typeof method !== 'string') {
    return { status: 400, body: rpcError(id ?? null, -32600, 'Invalid Request') };
  }
  if (method.startsWith('notifications/')) {
    return { status: 202, body: Buffer.alloc(0) };
  }
  if (isNotification) {
    return { status: 202, body: Buffer.alloc(0) };
  }

  const params = (request['params'] ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        protocolVersion: '2026-07-28',
        serverInfo: { ...SERVER_INFO },
        capabilities: { tools: {} },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO },
          'io.modelcontextprotocol/clientInfo': (params['clientInfo'] as Record<string, unknown> | undefined) ?? {},
          'io.modelcontextprotocol/clientCapabilities': (params['clientCapabilities'] as Record<string, unknown> | undefined) ?? {},
        },
      }),
    };
  }

  if (method === 'initialize') {
    const offered = params['protocolVersion'];
    const negotiated =
      typeof offered === 'string' && SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return {
      status: 200,
      headers: { 'Mcp-Session-Id': 'forge-disk-1' },
      body: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      }),
    };
  }

  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }

  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }

  if (method === 'tools/call') {
    const toolName = params['name'];
    const args = (params['arguments'] ?? {}) as Record<string, unknown>;
    if (typeof toolName !== 'string' || toolName === '') {
      return { status: 200, body: rpcError(id, -32602, 'Missing tool name') };
    }
    try {
      const outcome = executeTool(store, toolName, args);
      return {
        status: 200,
        body: rpcResult(id, {
          content: [{ type: 'text', text: outcome.text }],
          structuredContent: outcome.structured,
        }),
      };
    } catch (err) {
      if (err instanceof ToolError) {
        const message = err.message;
        if (message.startsWith('Unknown tool:')) {
          return { status: 200, body: rpcError(id, -32602, message) };
        }
        if (message.startsWith('Missing required argument:')) {
          return { status: 200, body: rpcError(id, -32602, message) };
        }
        return {
          status: 200,
          body: rpcResult(id, {
            content: [{ type: 'text', text: message }],
            isError: true,
          }),
        };
      }
      return {
        status: 200,
        body: rpcResult(id, {
          content: [{ type: 'text', text: err instanceof Error ? err.message : 'Tool call failed' }],
          isError: true,
        }),
      };
    }
  }

  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}

export { globalId };
