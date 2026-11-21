// REST v3: the GitHub API surface the suite exercises, on top of ForgeStore.
// Every reply is JSON with a non-empty X-GitHub-Request-Id; unknown routes
// answer 404 JSON, never HTML. Auth is the bearer token from the environment:
// a missing or wrong token is 401 everywhere under /api/v3.
//
// The JSON shapes here (repo / issue / pull / comment / branch / ref /
// commit / contents) are also the shapes GraphQL and MCP render from, so the
// record constructors live here and are shared by those modules.

import {
  DEFAULT_BRANCH,
  FIXED_ISO,
  ForgeStore,
  globalId,
  type CommentRecord,
  type IssueRecord,
  type PullRecord,
  type RepoRecord,
} from './store.ts';

export interface RestRequest {
  method: string;
  segments: string[]; // decoded path segments, without the leading /api/v3
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  origin: string; // e.g. http://127.0.0.1:12345
  body: Buffer | undefined;
}

export interface RestResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown; // JSON value, or a Buffer sent as-is
}

export function json(status: number, body: unknown, headers?: Record<string, string>): RestResponse {
  return { status, headers, body };
}

export function errorJson(status: number, message: string): RestResponse {
  return json(status, { message });
}

function isAuthed(req: RestRequest): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  if (!token) return true;
  return req.headers['authorization'] === `Bearer ${token}`;
}

function parseJsonBody(req: RestRequest): { ok: true; value: Record<string, unknown> } | { ok: false; response: RestResponse } {
  if (req.body === undefined || req.body.length === 0) return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(req.body.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, response: errorJson(400, 'Problems parsing JSON') };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, response: errorJson(400, 'Problems parsing JSON') };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

// ---------------------------------------------------------------------------
// record construction and JSON shapes
// ---------------------------------------------------------------------------

export function viewerLoginOf(store: ForgeStore): string {
  return store.viewerLogin ?? '';
}

export function repoJson(store: ForgeStore, repo: RepoRecord): Record<string, unknown> {
  const owner = repo.owner ?? viewerLoginOf(store);
  return {
    id: repo.databaseId,
    node_id: globalId('Repository', owner, repo.name),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, node_id: globalId('User', owner, ''), type: 'User' },
    private: repo.private,
    html_url: `${owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/repos/${owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function createIssueRecord(
  store: ForgeStore,
  repo: RepoRecord,
  fields: { title: string; body?: string; labels?: string[] },
): IssueRecord {
  repo.numberCounter += 1;
  const number = repo.numberCounter;
  const owner = repo.owner ?? viewerLoginOf(store);
  return {
    number,
    id: repo.databaseId * 100000 + number,
    nodeId: globalId('Issue', owner, repo.name, number),
    title: fields.title,
    body: fields.body ?? '',
    state: 'open',
    labels: fields.labels ?? [],
    comments: [],
    seq: number,
  };
}

export function createPullRecord(
  store: ForgeStore,
  repo: RepoRecord,
  fields: { title: string; body?: string; headRef: string; baseRef: string; headSha: string; baseSha: string },
): PullRecord {
  repo.numberCounter += 1;
  const number = repo.numberCounter;
  const owner = repo.owner ?? viewerLoginOf(store);
  return {
    number,
    id: repo.databaseId * 100000 + number,
    nodeId: globalId('PullRequest', owner, repo.name, number),
    title: fields.title,
    body: fields.body ?? '',
    state: 'open',
    headRef: fields.headRef,
    baseRef: fields.baseRef,
    headSha: fields.headSha,
    baseSha: fields.baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: number,
  };
}

export function issueJson(store: ForgeStore, repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
  const owner = repo.owner ?? viewerLoginOf(store);
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: owner, id: 1, type: 'User' },
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed', description: '' })),
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    author_association: 'OWNER',
    html_url: `/repos/${owner}/${repo.name}/issues/${issue.number}`,
    url: `/repos/${owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/repos/${owner}/${repo.name}`,
  };
}

export function pullJson(store: ForgeStore, repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
  const owner = repo.owner ?? viewerLoginOf(store);
  return {
    id: pull.id,
    node_id: pull.nodeId,
    number: pull.number,
    state: pull.merged ? 'closed' : pull.state,
    title: pull.title,
    body: pull.body,
    user: { login: owner, id: 1, type: 'User' },
    head: { label: `${owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, user: { login: owner } },
    base: { label: `${owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, user: { login: owner } },
    merged: pull.merged,
    mergeable: pull.merged ? false : !mergeWouldConflict(store, repo, pull),
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    draft: false,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    html_url: `/repos/${owner}/${repo.name}/pull/${pull.number}`,
    url: `/repos/${owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function commentJson(store: ForgeStore, repo: RepoRecord, comment: CommentRecord): Record<string, unknown> {
  const owner = repo.owner ?? viewerLoginOf(store);
  return {
    id: comment.id,
    node_id: comment.nodeId,
    body: comment.body,
    user: { login: owner, id: 1, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `/repos/${owner}/${repo.name}/issues/comments/${comment.id}`,
    url: `/repos/${owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

/** Would a squash merge of this pull conflict (three-way, same rule as the store)? */
export function mergeWouldConflict(store: ForgeStore, repo: RepoRecord, pull: PullRecord): boolean {
  const owner = repo.owner ?? viewerLoginOf(store);
  const baseTip = store.getRef(owner, repo.name, `refs/heads/${pull.baseRef}`);
  const headTip = store.getRef(owner, repo.name, `refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return true;
  const baseCommit = store.peelToCommit(baseTip);
  const headCommit = store.peelToCommit(headTip);
  const base = store.mergeBase(baseCommit, headCommit);
  if (base === null) return false;
  const baseInfo = store.commitInfo(base);
  const baseTipInfo = store.commitInfo(baseCommit);
  const headInfo = store.commitInfo(headCommit);
  if (!baseInfo || !baseTipInfo || !headInfo) return true;
  const baseFiles = store.flattenTree(baseInfo.tree);
  const baseTipFiles = store.flattenTree(baseTipInfo.tree);
  const headFiles = store.flattenTree(headInfo.tree);
  const paths = new Set([...baseFiles.keys(), ...baseTipFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const atBase = baseFiles.get(path)?.oid;
    const atBaseTip = baseTipFiles.get(path)?.oid;
    const atHead = headFiles.get(path)?.oid;
    if (atBaseTip !== atBase && atHead !== atBase && atBaseTip !== atHead) return true;
  }
  return false;
}

function commitJson(
  store: ForgeStore,
  repo: RepoRecord,
  sha: string,
): Record<string, unknown> | undefined {
  const info = store.commitInfo(store.peelToCommit(sha));
  if (!info) return undefined;
  const owner = repo.owner ?? viewerLoginOf(store);
  const message = info.message.replace(/\n+$/, '');
  const author = { name: owner, email: `${owner}@example.invalid`, date: FIXED_ISO };
  return {
    sha,
    node_id: globalId('Commit', owner, repo.name),
    commit: {
      message,
      author,
      committer: author,
      tree: { sha: info.tree, url: `/repos/${owner}/${repo.name}/git/trees/${info.tree}` },
      url: `/repos/${owner}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
    },
    url: `/repos/${owner}/${repo.name}/commits/${sha}`,
    html_url: `/repos/${owner}/${repo.name}/commit/${sha}`,
    author: { login: owner, id: 1, type: 'User' },
    committer: { login: owner, id: 1, type: 'User' },
    parents: info.parents.map((parent) => ({ sha: parent, url: `/repos/${owner}/${repo.name}/commits/${parent}` })),
  };
}

function fileContentJson(
  store: ForgeStore,
  repo: RepoRecord,
  path: string,
  blobOid: string,
  branch: string,
): Record<string, unknown> {
  const owner = repo.owner ?? viewerLoginOf(store);
  const object = store.getObject(blobOid);
  const data = object?.data ?? Buffer.alloc(0);
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: Buffer.from(data).toString('base64'),
    sha: blobOid,
    url: `/repos/${owner}/${repo.name}/contents/${path}?ref=${branch}`,
    git_url: `/repos/${owner}/${repo.name}/git/blobs/${blobOid}`,
    html_url: `/repos/${owner}/${repo.name}/blob/${branch}/${path}`,
    download_url: `/repos/${owner}/${repo.name}/raw/${branch}/${path}`,
    _links: { git: `/repos/${owner}/${repo.name}/git/blobs/${blobOid}`, self: `/repos/${owner}/${repo.name}/contents/${path}`, html: `/repos/${owner}/${repo.name}/blob/${branch}/${path}` },
  };
}

// ---------------------------------------------------------------------------
// routing helpers
// ---------------------------------------------------------------------------

/** Resolve a repository by owner and name; learns the viewer when the owner matches. */
export function resolveRepo(store: ForgeStore, owner: string, name: string): RepoRecord | undefined {
  const repo = store.getRepo(owner, name);
  if (repo) store.learnViewer(owner);
  return repo;
}

function paginate<T>(
  items: T[],
  query: URLSearchParams,
  path: string,
  origin: string,
): { page: T[]; link: string | undefined } {
  const perPage = Math.max(1, Number(query.get('per_page') ?? '30') || 30);
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const hasNext = start + perPage < items.length;
  const link = hasNext
    ? `<${origin}${path}?per_page=${perPage}&page=${page + 1}>; rel="next"`
    : undefined;
  return { page: slice, link };
}

function branchTip(store: ForgeStore, repo: RepoRecord, branch: string): string | undefined {
  const owner = repo.owner ?? viewerLoginOf(store);
  const tip = store.getRef(owner, repo.name, `refs/heads/${branch}`);
  return tip === undefined ? undefined : store.peelToCommit(tip);
}

function treeAtPath(
  store: ForgeStore,
  treeOid: string,
  path: string,
): { kind: 'file'; oid: string } | { kind: 'dir'; oid: string } | undefined {
  if (path === '') return { kind: 'dir', oid: treeOid };
  const segments = path.split('/');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const entries = store.treeEntries(current);
    if (!entries) return undefined;
    const entry = entries.find((item) => item.name === segments[index]);
    if (!entry) return undefined;
    const isLast = index === segments.length - 1;
    if (entry.mode === '40000') {
      if (!isLast) {
        current = entry.oid;
        continue;
      }
      return { kind: 'dir', oid: entry.oid };
    }
    if (!isLast) return undefined;
    return { kind: 'file', oid: entry.oid };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------

export function handleRest(store: ForgeStore, req: RestRequest): RestResponse | null {
  const commonHeaders: Record<string, string> = {
    'X-OAuth-Scopes': 'repo, user',
    'X-GitHub-Request-Id': store.nextRequestId(),
  };
  // The 401 is a REST reply too: it must carry X-GitHub-Request-Id like any other.
  if (!isAuthed(req)) return json(401, { message: 'Bad credentials' }, commonHeaders);
  const seg = req.segments;
  const method = req.method;

  // GET /api/v3
  if (seg.length === 0) {
    if (method !== 'GET') return errorJson(404, 'Not Found');
    return json(
      200,
      {
        current_user_url: `${req.origin}/api/v3/user`,
        repository_url: `${req.origin}/api/v3/repos/{owner}/{repo}`,
        user_repositories_url: `${req.origin}/api/v3/user/repos`,
      },
      commonHeaders,
    );
  }

  // GET /api/v3/meta
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') return errorJson(404, 'Not Found');
    return json(
      200,
      {
        verifiable_password_authentication: true,
        installed_version: '1.0.0',
        hooks: [],
        git: [],
        pages: [],
      },
      commonHeaders,
    );
  }

  // GET /api/v3/user
  if (seg.length === 1 && seg[0] === 'user') {
    if (method !== 'GET') return errorJson(404, 'Not Found');
    const login = viewerLoginOf(store);
    return json(
      200,
      { login, id: 1, node_id: globalId('User', login, ''), type: 'User', site_admin: false },
      commonHeaders,
    );
  }

  // /api/v3/user/repos
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const viewer = viewerLoginOf(store);
      const owned = store
        .listRepos()
        .filter((repo) => viewer === '' || repo.owner === null || repo.owner === viewer);
      const { page, link } = paginate(owned, req.query, '/api/v3/user/repos', req.origin);
      const headers: Record<string, string> = { ...commonHeaders };
      if (link) headers['Link'] = link;
      return json(200, page.map((repo) => repoJson(store, repo)), headers);
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) return parsed.response;
      const name = asString(parsed.value['name']);
      if (!name) return errorJson(422, 'name is required');
      if (store.repoExists(name)) return errorJson(422, 'Repository already exists');
      const record = store.createRepo(name, {
        description: asString(parsed.value['description']),
        private: parsed.value['private'] === true,
        defaultBranch: asString(parsed.value['default_branch']),
      });
      return json(201, repoJson(store, record), commonHeaders);
    }
    return errorJson(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{name}/...
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = seg[1]!;
    const name = seg[2]!;
    const rest = seg.slice(3);
    const repo = resolveRepo(store, owner, name);
    if (!repo) return errorJson(404, 'Not Found');

    // GET/PATCH/DELETE /repos/{owner}/{name}
    if (rest.length === 0) {
      if (method === 'GET') return json(200, repoJson(store, repo), commonHeaders);
      if (method === 'PATCH') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.response;
        const description = asString(parsed.value['description']);
        if (description !== undefined) repo.description = description;
        if (typeof parsed.value['private'] === 'boolean') repo.private = parsed.value['private'] as boolean;
        const branch = asString(parsed.value['default_branch']);
        if (branch) repo.defaultBranch = branch;
        return json(200, repoJson(store, repo), commonHeaders);
      }
      if (method === 'DELETE') {
        store.deleteRepo(name);
        return { status: 204, headers: commonHeaders, body: Buffer.alloc(0) };
      }
      return errorJson(404, 'Not Found');
    }

    // GET /repos/{o}/{r}/branches — list every branch with its tip.
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      const branches = store
        .listRefs(owner, name, repo.defaultBranch)
        .filter((ref) => ref.name.startsWith('refs/heads/'))
        .map((ref) => {
          const branch = ref.name.slice('refs/heads/'.length);
          return {
            name: branch,
            commit: { sha: ref.oid, url: `/repos/${owner}/${name}/commits/${ref.oid}` },
            protected: false,
          };
        });
      return json(200, branches, commonHeaders);
    }

    // GET /repos/{o}/{r}/branches/{branch}
    if (rest.length === 2 && rest[0] === 'branches' && method === 'GET') {
      const branch = rest[1]!;
      const tip = branchTip(store, repo, branch);
      if (tip === undefined) return errorJson(404, 'Not Found');
      return json(
        200,
        { name: branch, commit: { sha: tip, url: `/repos/${owner}/${name}/commits/${tip}` }, protected: false },
        commonHeaders,
      );
    }

    // POST /repos/{o}/{r}/git/refs — create a branch ref at a commit sha.
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) return parsed.response;
      const ref = asString(parsed.value['ref']);
      const sha = asString(parsed.value['sha']);
      if (ref === undefined || !ref.startsWith('refs/heads/') || ref === 'refs/heads/') {
        return errorJson(422, 'Invalid ref: only refs/heads/<branch> can be created here');
      }
      if (sha === undefined || store.commitInfo(sha) === undefined) {
        return errorJson(422, 'Invalid sha: not a known commit');
      }
      if (store.getRef(owner, name, ref) !== undefined) {
        return errorJson(422, 'Reference already exists');
      }
      store.setRef(owner, name, ref, sha);
      return json(
        201,
        {
          ref,
          node_id: globalId('Ref', owner, name),
          url: `/repos/${owner}/${name}/git/refs/${ref}`,
          object: { sha, type: 'commit', url: `/repos/${owner}/${name}/git/commits/${sha}` },
        },
        commonHeaders,
      );
    }

    // GET /repos/{o}/{r}/git/refs/heads/{branch}
    if (rest.length === 4 && rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && method === 'GET') {
      const branch = rest[3]!;
      const tip = branchTip(store, repo, branch);
      if (tip === undefined) return errorJson(404, 'Not Found');
      return json(
        200,
        {
          ref: `refs/heads/${branch}`,
          node_id: globalId('Ref', owner, name),
          url: `/repos/${owner}/${name}/git/refs/heads/${branch}`,
          object: { sha: tip, type: 'commit', url: `/repos/${owner}/${name}/git/commits/${tip}` },
        },
        commonHeaders,
      );
    }

    // GET /repos/{o}/{r}/commits
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const branch = req.query.get('sha') ?? repo.defaultBranch;
      const tip = branchTip(store, repo, branch);
      if (tip === undefined) return json(200, [], commonHeaders);
      const list = store.commitList(tip);
      const { page, link } = paginate(list, req.query, `/api/v3/repos/${owner}/${name}/commits`, req.origin);
      const headers: Record<string, string> = { ...commonHeaders };
      if (link) headers['Link'] = link;
      const items: unknown[] = [];
      for (const sha of page) {
        const item = commitJson(store, repo, sha);
        if (item) items.push(item);
      }
      return json(200, items, headers);
    }

    // /repos/{o}/{r}/contents[/{path...}]
    if (rest.length >= 1 && rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      const branch = req.query.get('ref') ?? repo.defaultBranch;
      if (method === 'GET') {
        const tip = branchTip(store, repo, branch);
        if (tip === undefined) return errorJson(404, 'Not Found');
        const info = store.commitInfo(tip);
        if (!info) return errorJson(404, 'Not Found');
        const target = treeAtPath(store, info.tree, path);
        if (!target) return errorJson(404, 'Not Found');
        if (target.kind === 'file') {
          return json(200, fileContentJson(store, repo, path, target.oid, branch), commonHeaders);
        }
        const entries = store.treeEntries(target.oid) ?? [];
        const items = entries.map((entry) => {
          const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
          if (entry.mode === '40000') {
            return {
              type: 'dir',
              name: entry.name,
              path: childPath,
              sha: entry.oid,
              size: 0,
              url: `/repos/${owner}/${name}/contents/${childPath}?ref=${branch}`,
              git_url: `/repos/${owner}/${name}/git/trees/${entry.oid}`,
              html_url: `/repos/${owner}/${name}/tree/${branch}/${childPath}`,
              download_url: null,
            };
          }
          const object = store.getObject(entry.oid);
          return {
            type: 'file',
            name: entry.name,
            path: childPath,
            sha: entry.oid,
            size: object?.data.length ?? 0,
            url: `/repos/${owner}/${name}/contents/${childPath}?ref=${branch}`,
            git_url: `/repos/${owner}/${name}/git/blobs/${entry.oid}`,
            html_url: `/repos/${owner}/${name}/blob/${branch}/${childPath}`,
            download_url: `/repos/${owner}/${name}/raw/${branch}/${childPath}`,
          };
        });
        return json(200, items, commonHeaders);
      }
      if (method === 'PUT' || method === 'DELETE') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.response;
        const body = parsed.value;
        const message = asString(body['message']) ?? (method === 'PUT' ? 'Update file' : 'Delete file');
        const targetBranch = asString(body['branch']) ?? repo.defaultBranch;
        const tip = branchTip(store, repo, targetBranch);
        let currentOid: string | undefined;
        if (tip !== undefined) {
          const info = store.commitInfo(tip);
          if (info) {
            const target = treeAtPath(store, info.tree, path);
            if (target?.kind === 'file') currentOid = target.oid;
          }
        }
        if (method === 'PUT') {
          const content = asString(body['content']);
          if (content === undefined) return errorJson(422, 'content is required');
          const givenSha = asString(body['sha']);
          if (currentOid !== undefined) {
            if (givenSha === undefined) return errorJson(409, 'sha does not match');
            if (givenSha !== currentOid) return errorJson(409, 'sha does not match');
          }
          const bytes = Buffer.from(content, 'base64');
          const { commitSha } = store.commitFiles(repo, targetBranch, message, new Map([[path, bytes]]));
          const blobOid = store.flattenTree(store.commitInfo(store.peelToCommit(commitSha))!.tree).get(path)?.oid ?? '';
          return json(
            currentOid === undefined ? 201 : 200,
            { content: fileContentJson(store, repo, path, blobOid, targetBranch), commit: { sha: commitSha, message } },
            commonHeaders,
          );
        }
        // DELETE contents
        if (currentOid === undefined) return errorJson(404, 'Not Found');
        const givenSha = asString(body['sha']);
        if (givenSha === undefined || givenSha !== currentOid) return errorJson(409, 'sha does not match');
        const { commitSha } = store.commitFiles(repo, targetBranch, message, new Map([[path, null]]));
        return json(200, { commit: { sha: commitSha, message } }, commonHeaders);
      }
      return errorJson(404, 'Not Found');
    }

    // /repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'GET') {
        return json(
          200,
          [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })),
          commonHeaders,
        );
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.response;
        const name = asString(parsed.value['name']);
        if (!name) return errorJson(422, 'name is required');
        if (repo.labels.has(name)) return errorJson(422, 'Label already exists');
        const color = asString(parsed.value['color']) ?? 'ededed';
        repo.labels.set(name, { name, color });
        return json(201, { name, color, description: '' }, commonHeaders);
      }
      return errorJson(404, 'Not Found');
    }

    // /repos/{o}/{r}/issues[/{n}[/comments]]
    if (rest.length >= 1 && rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          const filtered = repo.issues.filter((issue) => state === 'all' || issue.state === state);
          // sort=created orders by creation sequence (seq): issues share one
          // fixed created_at, so the timestamp alone cannot order them.
          // direction=desc (newest first) is the GitHub default.
          let ordered = filtered;
          if (req.query.get('sort') === 'created') {
            const direction = req.query.get('direction') ?? 'desc';
            ordered = [...filtered].sort((a, b) =>
              direction === 'asc' ? a.seq - b.seq : b.seq - a.seq,
            );
          }
          const { page, link } = paginate(ordered, req.query, `/api/v3/repos/${owner}/${name}/issues`, req.origin);
          const headers: Record<string, string> = { ...commonHeaders };
          if (link) headers['Link'] = link;
          return json(200, page.map((issue) => issueJson(store, repo, issue)), headers);
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(req);
          if (!parsed.ok) return parsed.response;
          const title = asString(parsed.value['title']);
          if (!title) return errorJson(422, 'title is required');
          const labels = asStringArray(parsed.value['labels']);
          for (const label of labels) {
            if (!repo.labels.has(label)) return errorJson(422, `Label does not exist: ${label}`);
          }
          const record = createIssueRecord(store, repo, {
            title,
            body: asString(parsed.value['body']),
            labels,
          });
          repo.issues.push(record);
          return json(201, issueJson(store, repo, record), commonHeaders);
        }
        return errorJson(404, 'Not Found');
      }
      const number = Number(rest[1]);
      const issue = repo.issues.find((item) => item.number === number);
      if (!issue) return errorJson(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return json(200, issueJson(store, repo, issue), commonHeaders);
        if (method === 'PATCH') {
          const parsed = parseJsonBody(req);
          if (!parsed.ok) return parsed.response;
          const title = asString(parsed.value['title']);
          if (title !== undefined) issue.title = title;
          const body = asString(parsed.value['body']);
          if (body !== undefined) issue.body = body;
          const state = asString(parsed.value['state']);
          if (state === 'open' || state === 'closed') issue.state = state;
          return json(200, issueJson(store, repo, issue), commonHeaders);
        }
        return errorJson(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          return json(200, issue.comments.map((comment) => commentJson(store, repo, comment)), commonHeaders);
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(req);
          if (!parsed.ok) return parsed.response;
          const body = asString(parsed.value['body']);
          if (body === undefined) return errorJson(422, 'body is required');
          repo.commentCounter += 1;
          const comment: CommentRecord = {
            id: repo.commentCounter,
            nodeId: globalId('IssueComment', owner, name, repo.commentCounter),
            body,
          };
          issue.comments.push(comment);
          return json(201, commentJson(store, repo, comment), commonHeaders);
        }
        return errorJson(404, 'Not Found');
      }
      return errorJson(404, 'Not Found');
    }

    // /repos/{o}/{r}/pulls[/{n}[/files|merge]]
    if (rest.length >= 1 && rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          const filtered = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
          const { page, link } = paginate(filtered, req.query, `/api/v3/repos/${owner}/${name}/pulls`, req.origin);
          const headers: Record<string, string> = { ...commonHeaders };
          if (link) headers['Link'] = link;
          return json(200, page.map((pull) => pullJson(store, repo, pull)), headers);
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(req);
          if (!parsed.ok) return parsed.response;
          const title = asString(parsed.value['title']);
          const head = asString(parsed.value['head']);
          const base = asString(parsed.value['base']);
          if (!title || !head || !base) return errorJson(422, 'title, head and base are required');
          const headTip = branchTip(store, repo, head);
          const baseTip = branchTip(store, repo, base);
          if (headTip === undefined) return errorJson(422, `head branch not found: ${head}`);
          if (baseTip === undefined) return errorJson(422, `base branch not found: ${base}`);
          const duplicate = repo.pulls.find(
            (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
          );
          if (duplicate) return errorJson(422, 'A pull request already exists for this head and base');
          const record = createPullRecord(store, repo, {
            title,
            body: asString(parsed.value['body']),
            headRef: head,
            baseRef: base,
            headSha: headTip,
            baseSha: baseTip,
          });
          repo.pulls.push(record);
          return json(201, pullJson(store, repo, record), commonHeaders);
        }
        return errorJson(404, 'Not Found');
      }
      const number = Number(rest[1]);
      const pull = repo.pulls.find((item) => item.number === number);
      if (!pull) return errorJson(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return json(200, pullJson(store, repo, pull), commonHeaders);
        if (method === 'PATCH') {
          const parsed = parseJsonBody(req);
          if (!parsed.ok) return parsed.response;
          const title = asString(parsed.value['title']);
          if (title !== undefined) pull.title = title;
          const body = asString(parsed.value['body']);
          if (body !== undefined) pull.body = body;
          const state = asString(parsed.value['state']);
          if (state === 'open' || state === 'closed') pull.state = state;
          return json(200, pullJson(store, repo, pull), commonHeaders);
        }
        return errorJson(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const baseInfo = store.commitInfo(store.peelToCommit(pull.baseSha));
        const headInfo = store.commitInfo(store.peelToCommit(pull.headSha));
        if (!baseInfo || !headInfo) return errorJson(404, 'Not Found');
        const files = store.diffFiles(baseInfo.tree, headInfo.tree).map((file) => ({
          sha: '',
          filename: file.filename,
          status: file.status === 'modified' ? 'modified' : file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
        }));
        return json(200, files, commonHeaders);
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull.merged || pull.state !== 'open') return errorJson(405, 'Pull request is not open');
        if (mergeWouldConflict(store, repo, pull)) return errorJson(405, 'Merge conflict');
        const result = store.squashMerge(repo, pull);
        if ('conflict' in result) return errorJson(405, 'Merge conflict');
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = FIXED_ISO;
        pull.mergeCommitSha = result.sha;
        return json(
          200,
          { sha: result.sha, merged: true, message: `Merge pull request #${pull.number}: ${pull.title}` },
          commonHeaders,
        );
      }
      return errorJson(404, 'Not Found');
    }
  }

  return null;
}
