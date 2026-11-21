// The forge store: git objects on disk (loose, content-addressed, exactly like
// git's own layout), refs as small files, and repository metadata in memory.
//
// Disk layout under the store directory:
//   objects/xx/<40-hex-sha1>   zlib of "<type> <size>\0<bytes>"
//   refs/<owner>/<repo>/<ref-path...>   one line: the oid the ref points at
// Hot objects sit in a small LRU so a clone of a stored pack never touches the
// disk twice for the same object. Nothing here reads a clock: commit
// timestamps come from a fixed epoch plus a deterministic counter, so the same
// request sequence always builds the same objects.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ZERO_OID,
  buildCommit,
  buildTree,
  decodeLoose,
  encodeLoose,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';

export const FIXED_EPOCH = 1735689600; // 2025-01-01T00:00:00Z, the only "now" this forge knows
export const FIXED_ISO = '2025-01-01T00:00:00Z';
export const DEFAULT_BRANCH = 'main';

export function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function globalId(kind: string, owner: string, name: string, number?: number): string {
  const tail = number === undefined ? '' : `#${number}`;
  return b64url(`${kind}:${owner}/${name}${tail}`);
}

export function decodeGlobalId(id: string): { kind: string; owner: string; name: string; number: number | null } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const match = /^([A-Za-z]+):([^/]+)\/([^#]+)(?:#(\d+))?$/.exec(text);
    if (!match) return null;
    return { kind: match[1]!, owner: match[2]!, name: match[3]!, number: match[4] ? Number(match[4]) : null };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// metadata records (in memory; git objects and refs are the durable part)
// ---------------------------------------------------------------------------

export interface LabelRecord {
  name: string;
  color: string;
}

export interface CommentRecord {
  id: number;
  nodeId: string;
  body: string;
}

export interface IssueRecord {
  number: number;
  id: number;
  nodeId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRecord[];
  seq: number;
}

export interface PullRecord {
  number: number;
  id: number;
  nodeId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface RepoRecord {
  owner: string | null; // bound on first owner-bearing access; null until then
  name: string;
  databaseId: number;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  labels: Map<string, LabelRecord>;
  issues: IssueRecord[];
  pulls: PullRecord[];
  numberCounter: number; // one shared counter for issues and pull requests
  commentCounter: number;
}

const MAX_CACHE_OBJECTS = 1500;

export class ForgeStore {
  readonly dir: string;
  /** The login the bearer token names, learned from the first owner-bearing request. */
  viewerLogin: string | null = null;
  private readonly objects = new Map<string, GitObject>();
  private readonly commitCache = new Map<string, { tree: string; parents: string[]; message: string }>();
  private readonly treeCache = new Map<string, TreeEntry[]>();
  private readonly refs = new Map<string, string>();
  private readonly repos = new Map<string, RepoRecord>();
  private repoSeq = 0;
  private commitSeq = 0;
  private requestSeq = 0;

  constructor(dir?: string) {
    this.dir = dir ?? process.env.FORGE_STORE_DIR ?? join(tmpdir(), 'makefun-forge-store');
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(join(this.dir, 'objects'), { recursive: true });
    mkdirSync(join(this.dir, 'refs'), { recursive: true });
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  /** A deterministic timestamp (seconds): fixed epoch plus a per-commit counter. */
  nextTimestamp(): number {
    this.commitSeq += 1;
    return FIXED_EPOCH + this.commitSeq;
  }

  learnViewer(owner: string): void {
    if (this.viewerLogin === null && owner !== '') this.viewerLogin = owner;
  }

  identity(): string {
    const login = this.viewerLogin ?? 'forge';
    return `${login} <${login}@example.invalid>`;
  }

  // ---------------------------------------------------------------- objects

  private objectPath(oid: string): string {
    return join(this.dir, 'objects', oid.slice(0, 2), oid.slice(2));
  }

  private cachePut(oid: string, object: GitObject): void {
    if (this.objects.has(oid)) this.objects.delete(oid);
    this.objects.set(oid, object);
    while (this.objects.size > MAX_CACHE_OBJECTS) {
      const oldest = this.objects.keys().next().value;
      if (oldest === undefined) break;
      this.objects.delete(oldest);
    }
  }

  putObject(type: GitObjectType, data: Uint8Array): string {
    const buffer = Buffer.from(data);
    const oid = hashObject(type, buffer);
    const object: GitObject = { type, data: buffer };
    this.cachePut(oid, object);
    const path = this.objectPath(oid);
    if (!existsSync(path)) {
      mkdirSync(join(this.dir, 'objects', oid.slice(0, 2)), { recursive: true });
      writeFileSync(path, encodeLoose(type, buffer));
    }
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    if (!isOid(oid)) return undefined;
    const cached = this.objects.get(oid);
    if (cached) return cached;
    const path = this.objectPath(oid);
    if (!existsSync(path)) return undefined;
    try {
      const object = decodeLoose(readFileSync(path));
      this.cachePut(oid, object);
      return object;
    } catch {
      return undefined;
    }
  }

  hasObject(oid: string): boolean {
    return this.getObject(oid) !== undefined;
  }

  commitInfo(oid: string): { tree: string; parents: string[]; message: string } | undefined {
    const cached = this.commitCache.get(oid);
    if (cached) return cached;
    const object = this.getObject(oid);
    if (!object || object.type !== 'commit') return undefined;
    try {
      const view = parseCommit(object.data);
      const info = { tree: view.tree, parents: view.parents, message: view.message };
      this.commitCache.set(oid, info);
      return info;
    } catch {
      return undefined;
    }
  }

  treeEntries(oid: string): TreeEntry[] | undefined {
    const cached = this.treeCache.get(oid);
    if (cached) return cached;
    const object = this.getObject(oid);
    if (!object || object.type !== 'tree') return undefined;
    try {
      const entries = parseTree(object.data);
      this.treeCache.set(oid, entries);
      return entries;
    } catch {
      return undefined;
    }
  }

  /** Follow tag objects until a non-tag object (usually a commit). */
  peelToCommit(oid: string): string {
    let current = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = this.getObject(current);
      if (!object || object.type !== 'tag') return current;
      try {
        current = parseTag(object.data).object;
      } catch {
        return current;
      }
    }
    return current;
  }

  /** Flatten a tree into path -> {oid, mode}, following nested trees. */
  flattenTree(treeOid: string, prefix = '', out: Map<string, { oid: string; mode: string }> = new Map()): Map<string, { oid: string; mode: string }> {
    const entries = this.treeEntries(treeOid);
    if (!entries) return out;
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
    return out;
  }

  /** Rebuild a tree from a flat path map, storing every intermediate tree. */
  buildTreeFromFlat(files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, value] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, value);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  // ---------------------------------------------------------------- refs

  private refKey(owner: string, repo: string, ref: string): string {
    return `${owner}\0${repo}\0${ref}`;
  }

  private refPath(owner: string, repo: string, ref: string): string {
    const safe = (part: string): string => encodeURIComponent(part);
    return join(this.dir, 'refs', safe(owner), safe(repo), ...ref.split('/').map(safe));
  }

  getRef(owner: string, repo: string, ref: string): string | undefined {
    return this.refs.get(this.refKey(owner, repo, ref));
  }

  setRef(owner: string, repo: string, ref: string, oid: string): void {
    this.refs.set(this.refKey(owner, repo, ref), oid);
    const path = this.refPath(owner, repo, ref);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${oid}\n`);
  }

  deleteRef(owner: string, repo: string, ref: string): void {
    this.refs.delete(this.refKey(owner, repo, ref));
    rmSync(this.refPath(owner, repo, ref), { force: true });
  }

  /** All refs of a repository, sorted by name. HEAD resolves to the default branch. */
  listRefs(owner: string, repo: string, defaultBranch: string): Array<{ name: string; oid: string }> {
    const prefix = `${owner}\0${repo}\0`;
    const out: Array<{ name: string; oid: string }> = [];
    for (const [key, oid] of this.refs) {
      if (!key.startsWith(prefix)) continue;
      out.push({ name: key.slice(prefix.length), oid });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const head = this.getRef(owner, repo, `refs/heads/${defaultBranch}`);
    if (head) out.unshift({ name: 'HEAD', oid: head });
    return out;
  }

  /** The default branch's tip, or undefined when the repository is unborn. */
  defaultTip(repo: RepoRecord): string | undefined {
    if (repo.owner === null) return undefined;
    return this.getRef(repo.owner, repo.name, `refs/heads/${repo.defaultBranch}`);
  }

  // ---------------------------------------------------------------- repos

  createRepo(name: string, options: { description?: string; private?: boolean; defaultBranch?: string }): RepoRecord {
    const record: RepoRecord = {
      owner: this.viewerLogin,
      name,
      databaseId: 5000 + this.repoSeq,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: options.defaultBranch ?? DEFAULT_BRANCH,
      createdSeq: this.repoSeq,
      labels: new Map(),
      issues: [],
      pulls: [],
      numberCounter: 0,
      commentCounter: 0,
    };
    this.repoSeq += 1;
    this.repos.set(name, record);
    return record;
  }

  /**
   * Look a repository up by owner and name. A repository created through
   * POST /user/repos has no owner yet: the first owner-bearing access binds it
   * to that owner (and learns the token's login). Any other owner reads 404.
   */
  getRepo(owner: string, name: string): RepoRecord | undefined {
    const record = this.repos.get(name);
    if (!record) return undefined;
    if (record.owner === null) {
      record.owner = owner;
      this.learnViewer(owner);
      return record;
    }
    return record.owner === owner ? record : undefined;
  }

  repoExists(name: string): boolean {
    return this.repos.has(name);
  }

  deleteRepo(name: string): boolean {
    const record = this.repos.get(name);
    if (!record) return false;
    if (record.owner !== null) {
      rmSync(join(this.dir, 'refs', encodeURIComponent(record.owner), encodeURIComponent(name)), {
        recursive: true,
        force: true,
      });
      const prefix = `${record.owner}\0${name}\0`;
      for (const key of [...this.refs.keys()]) if (key.startsWith(prefix)) this.refs.delete(key);
    }
    this.repos.delete(name);
    return true;
  }

  listRepos(): RepoRecord[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // ---------------------------------------------------------------- commits

  /**
   * Commit a set of file changes on a branch. `changes` maps a path to new
   * bytes, or null to delete the path. Creates the branch from the default
   * tip when it does not exist yet (an unborn repository starts a root commit).
   */
  commitFiles(
    repo: RepoRecord,
    branch: string,
    message: string,
    changes: Map<string, Buffer | null>,
  ): { commitSha: string; treeSha: string } {
    const owner = repo.owner ?? this.viewerLogin ?? 'forge';
    const ref = `refs/heads/${branch}`;
    let tip = this.getRef(owner, repo.name, ref);
    if (tip === undefined && branch !== repo.defaultBranch) {
      tip = this.defaultTip(repo);
    }
    const flat = new Map<string, { oid: string; mode: string }>();
    if (tip !== undefined) {
      const info = this.commitInfo(this.peelToCommit(tip));
      if (info) this.flattenTree(info.tree, '', flat);
    }
    for (const [path, content] of changes) {
      if (content === null) flat.delete(path);
      else flat.set(path, { oid: this.putObject('blob', content), mode: '100644' });
    }
    const treeSha = this.buildTreeFromFlat(flat);
    const identity = this.identity();
    const commitSha = this.putObject(
      'commit',
      buildCommit({
        tree: treeSha,
        parents: tip === undefined ? [] : [this.peelToCommit(tip)],
        message,
        author: identity,
        committer: identity,
        timestamp: this.nextTimestamp(),
      }),
    );
    this.setRef(owner, repo.name, ref, commitSha);
    return { commitSha, treeSha };
  }

  /** Walk a tip's history, newest first (depth-first, parents in order). */
  commitList(tip: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const visit = (oid: string): void => {
      const commit = this.peelToCommit(oid);
      if (seen.has(commit)) return;
      seen.add(commit);
      const info = this.commitInfo(commit);
      if (!info) return;
      out.push(commit);
      for (const parent of info.parents) visit(parent);
    };
    visit(tip);
    return out;
  }

  /** Is `ancestor` reachable from `tip` (or equal to it)? */
  isAncestor(ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const stack = [this.peelToCommit(tip)];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === ancestor) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const info = this.commitInfo(current);
      if (info) for (const parent of info.parents) stack.push(parent);
    }
    return false;
  }

  /** A common ancestor of two commits (the first one found walking both sides). */
  mergeBase(a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const stack = [this.peelToCommit(a)];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (ancestorsA.has(current)) continue;
      ancestorsA.add(current);
      const info = this.commitInfo(current);
      if (info) for (const parent of info.parents) stack.push(parent);
    }
    const queue = [this.peelToCommit(b)];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (ancestorsA.has(current)) return current;
      if (seen.has(current)) continue;
      seen.add(current);
      const info = this.commitInfo(current);
      if (info) for (const parent of info.parents) queue.push(parent);
    }
    return null;
  }

  /** Line counts for a changed file: lines added and removed (multiset diff). */
  static lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
    const oldLines = oldText === '' ? [] : oldText.split('\n');
    const newLines = newText === '' ? [] : newText.split('\n');
    const oldCounts = new Map<string, number>();
    for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
    let additions = 0;
    for (const line of newLines) {
      const left = oldCounts.get(line) ?? 0;
      if (left > 0) oldCounts.set(line, left - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const left of oldCounts.values()) deletions += left;
    return { additions, deletions };
  }

  /** The changed paths between two trees, with line counts. */
  diffFiles(baseTreeOid: string, headTreeOid: string): Array<{
    filename: string;
    status: 'added' | 'modified' | 'removed';
    additions: number;
    deletions: number;
    changes: number;
  }> {
    const base = this.flattenTree(baseTreeOid);
    const head = this.flattenTree(headTreeOid);
    const out: Array<{
      filename: string;
      status: 'added' | 'modified' | 'removed';
      additions: number;
      deletions: number;
      changes: number;
    }> = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const from = base.get(path);
      const to = head.get(path);
      if (from && !to) {
        const oldText = this.getObject(from.oid)?.data.toString('utf8') ?? '';
        const diff = ForgeStore.lineDiff(oldText, '');
        out.push({ filename: path, status: 'removed', additions: 0, deletions: diff.deletions, changes: diff.deletions });
      } else if (!from && to) {
        const newText = this.getObject(to.oid)?.data.toString('utf8') ?? '';
        const diff = ForgeStore.lineDiff('', newText);
        out.push({ filename: path, status: 'added', additions: diff.additions, deletions: 0, changes: diff.additions });
      } else if (from && to && from.oid !== to.oid) {
        const oldText = this.getObject(from.oid)?.data.toString('utf8') ?? '';
        const newText = this.getObject(to.oid)?.data.toString('utf8') ?? '';
        const diff = ForgeStore.lineDiff(oldText, newText);
        out.push({
          filename: path,
          status: 'modified',
          additions: diff.additions,
          deletions: diff.deletions,
          changes: diff.additions + diff.deletions,
        });
      }
    }
    return out;
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge
   * commit, or a conflict flag when both sides changed the same path in
   * different ways since their merge base.
   */
  squashMerge(repo: RepoRecord, pull: PullRecord): { sha: string } | { conflict: true } {
    const owner = repo.owner ?? this.viewerLogin ?? 'forge';
    const baseTip = this.getRef(owner, repo.name, `refs/heads/${pull.baseRef}`);
    const headTip = this.getRef(owner, repo.name, `refs/heads/${pull.headRef}`);
    if (baseTip === undefined || headTip === undefined) return { conflict: true };
    const baseCommit = this.peelToCommit(baseTip);
    const headCommit = this.peelToCommit(headTip);
    const base = this.mergeBase(baseCommit, headCommit);
    if (base !== null) {
      const baseInfo = this.commitInfo(base);
      const baseTipInfo = this.commitInfo(baseCommit);
      const headInfo = this.commitInfo(headCommit);
      if (baseInfo && baseTipInfo && headInfo) {
        const baseFiles = this.flattenTree(baseInfo.tree);
        const baseTipFiles = this.flattenTree(baseTipInfo.tree);
        const headFiles = this.flattenTree(headInfo.tree);
        const paths = new Set([...baseFiles.keys(), ...baseTipFiles.keys(), ...headFiles.keys()]);
        for (const path of paths) {
          const atBase = baseFiles.get(path)?.oid;
          const atBaseTip = baseTipFiles.get(path)?.oid;
          const atHead = headFiles.get(path)?.oid;
          const baseChanged = atBaseTip !== atBase;
          const headChanged = atHead !== atBase;
          if (baseChanged && headChanged && atBaseTip !== atHead) return { conflict: true };
        }
      }
    }
    const headInfo = this.commitInfo(headCommit);
    if (!headInfo) return { conflict: true };
    const identity = this.identity();
    const message = `Merge pull request #${pull.number}: ${pull.title}`;
    const sha = this.putObject(
      'commit',
      buildCommit({
        tree: headInfo.tree,
        parents: [baseCommit],
        message,
        author: identity,
        committer: identity,
        timestamp: this.nextTimestamp(),
      }),
    );
    this.setRef(owner, repo.name, `refs/heads/${pull.baseRef}`, sha);
    return { sha };
  }
}

export { ZERO_OID };
