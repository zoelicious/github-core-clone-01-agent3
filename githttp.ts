// Git smart HTTP: info/refs advertisements, upload-pack protocol v2 and v0,
// and receive-pack v0. No git binary anywhere: advertisements, packfiles and
// the report-status stream are all built from the object store by hand.
//
// Fetch selection (the part that decides what a clone carries):
//   * wants are walked by commit distance from their tips; `deepen N` keeps
//     only commits closer than N, and the commits at the cut are reported as
//     shallow (their parents are not sent);
//   * haves are walked the same way, stopping at the client's shallow
//     boundary, and anything they reach is not re-sent;
//   * a tag want contributes its tag object plus its target's closure.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  isOid,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  splitAtFlush,
  writePack,
  type GitObject,
} from './git.ts';
import { ForgeStore, type RepoRecord } from './store.ts';

export interface GitRequest {
  owner: string;
  repo: string;
  service: 'git-upload-pack' | 'git-receive-pack';
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'forge-disk/1.0';

function sidebandPackets(data: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  const chunkSize = 60000;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + chunkSize));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}

/** The peeled commit a ref points at, for ls-refs `peeled:` output. */
function peeledCommit(store: ForgeStore, oid: string): string | undefined {
  const object = store.getObject(oid);
  if (!object) return undefined;
  if (object.type === 'tag') {
    try {
      return store.peelToCommit(oid);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function refLinesV0(
  store: ForgeStore,
  repo: RepoRecord,
  service: 'git-upload-pack' | 'git-receive-pack',
): string[] {
  const owner = repo.owner ?? '';
  const refs = store.listRefs(owner, repo.name, repo.defaultBranch);
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow multi_ack multi_ack_detailed symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const realRefs = refs.filter((ref) => ref.name !== 'HEAD');
  if (realRefs.length === 0) {
    return [`${ZERO_OID} capabilities^{}\0${caps}\n`];
  }
  const lines: string[] = [];
  const head = refs.find((ref) => ref.name === 'HEAD');
  if (head) lines.push(`${head.oid} HEAD\0${caps}\n`);
  else lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  for (const ref of realRefs) {
    lines.push(`${ref.oid} ${ref.name}\n`);
    const peeled = peeledCommit(store, ref.oid);
    if (peeled !== undefined && peeled !== ref.oid) lines.push(`${peeled} ${ref.name}^{}\n`);
  }
  return lines;
}

function advertisementV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    pktFlush(),
  ]);
}

function advertisementV0(store: ForgeStore, repo: RepoRecord, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const serviceLine = `# service=${service}\n`;
  const lines = refLinesV0(store, repo, service);
  return Buffer.concat([pktLine(serviceLine), pktFlush(), ...lines.map((line) => pktLine(line)), pktFlush()]);
}

export function handleInfoRefs(store: ForgeStore, req: GitRequest): GitResponse {
  const repo = store.getRepo(req.owner, req.repo);
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
  }
  store.learnViewer(req.owner);
  const contentType =
    req.service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
  if (req.service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2') {
    return { status: 200, contentType, body: advertisementV2() };
  }
  return { status: 200, contentType, body: advertisementV0(store, repo, req.service) };
}

// ---------------------------------------------------------------------------
// fetch selection
// ---------------------------------------------------------------------------

interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

function commitDistance(store: ForgeStore, tips: string[]): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const tip of tips) {
    const commit = store.peelToCommit(tip);
    if (!dist.has(commit)) {
      dist.set(commit, 0);
      queue.push(commit);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!;
    const depth = dist.get(current)!;
    const info = store.commitInfo(current);
    if (!info) continue;
    for (const parent of info.parents) {
      if (!dist.has(parent)) {
        dist.set(parent, depth + 1);
        queue.push(parent);
      }
    }
  }
  return dist;
}

/** The objects reachable from `tips` (commits, trees, blobs, tag objects). */
function closureObjects(
  store: ForgeStore,
  tips: string[],
  stopAt: ReadonlySet<string>,
  maxDepth?: number,
): { commits: Set<string>; objects: Map<string, GitObject> } {
  const dist = commitDistance(store, tips);
  const commits = new Set<string>();
  for (const [oid, depth] of dist) {
    if (maxDepth !== undefined && depth >= maxDepth) continue;
    commits.add(oid);
  }
  // Shallow stop: a commit in `stopAt` is included but its parents are not.
  if (maxDepth === undefined) {
    const pruned = new Set<string>();
    const queue: Array<{ oid: string; blocked: boolean }> = [];
    for (const tip of tips) queue.push({ oid: store.peelToCommit(tip), blocked: false });
    const seen = new Set<string>();
    while (queue.length > 0) {
      const { oid, blocked } = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (blocked) continue;
      pruned.add(oid);
      if (stopAt.has(oid)) continue;
      const info = store.commitInfo(oid);
      if (info) for (const parent of info.parents) queue.push({ oid: parent, blocked: false });
    }
    for (const oid of [...commits]) if (!pruned.has(oid)) commits.delete(oid);
  }
  const objects = new Map<string, GitObject>();
  const addObject = (oid: string): void => {
    const object = store.getObject(oid);
    if (object && !objects.has(oid)) objects.set(oid, object);
  };
  for (const tip of tips) {
    const object = store.getObject(tip);
    if (object?.type === 'tag') addObject(tip);
  }
  for (const commit of commits) {
    addObject(commit);
    const info = store.commitInfo(commit);
    if (!info) continue;
    const flat = store.flattenTree(info.tree);
    for (const entry of flat.values()) addObject(entry.oid);
    // The tree objects themselves (root and nested) also travel.
    const walkTrees = (treeOid: string): void => {
      addObject(treeOid);
      const entries = store.treeEntries(treeOid);
      if (!entries) return;
      for (const entry of entries) if (entry.mode === '40000') walkTrees(entry.oid);
    };
    walkTrees(info.tree);
  }
  return { commits, objects };
}

function selectFetch(
  store: ForgeStore,
  wants: string[],
  haves: string[],
  shallow: string[],
  depth: number | undefined,
): FetchSelection {
  const shallowSet = new Set(shallow);
  const wanted = closureObjects(store, wants, shallowSet, depth);
  const held = haves.length > 0 ? closureObjects(store, haves, shallowSet, undefined) : { commits: new Set<string>(), objects: new Map<string, GitObject>() };
  const objects: GitObject[] = [];
  for (const [oid, object] of [...wanted.objects.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!held.objects.has(oid)) objects.push(object);
  }
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  if (depth !== undefined) {
    const dist = commitDistance(store, wants);
    for (const [oid, d] of dist) {
      if (d === depth - 1 && wanted.commits.has(oid)) shallowOut.push(oid);
    }
  }
  for (const old of shallow) {
    if (!wanted.commits.has(old)) continue;
    const info = store.commitInfo(store.peelToCommit(old));
    const parentsIncluded = (info?.parents ?? []).every((parent) => wanted.commits.has(parent));
    if (parentsIncluded && (info?.parents.length ?? 0) > 0) unshallowOut.push(old);
    else if (!shallowOut.includes(old)) shallowOut.push(old);
  }
  const acks: string[] = [];
  if (haves.length > 0) {
    const full = closureObjects(store, wants, new Set(), undefined);
    for (const have of haves) {
      try {
        if (full.commits.has(store.peelToCommit(have)) || full.objects.has(have)) acks.push(have);
      } catch {
        // A have the server cannot resolve is simply not acknowledged.
      }
    }
  }
  shallowOut.sort();
  unshallowOut.sort();
  return { objects, shallow: shallowOut, unshallow: unshallowOut, acks };
}

// ---------------------------------------------------------------------------
// upload-pack v2
// ---------------------------------------------------------------------------

function fetchResponseV2(selection: FetchSelection): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (selection.acks.length > 0) {
    for (const ack of selection.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktDelim());
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  const pack = writePack(selection.objects);
  for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function lsRefsResponseV2(
  store: ForgeStore,
  repo: RepoRecord,
  args: { peel: boolean; symrefs: boolean; prefixes: string[] },
): Buffer {
  const owner = repo.owner ?? '';
  const all = store.listRefs(owner, repo.name, repo.defaultBranch);
  const lines: string[] = [];
  const defaultTip = store.getRef(owner, repo.name, `refs/heads/${repo.defaultBranch}`);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (keep('HEAD')) {
    if (defaultTip) {
      lines.push(`${defaultTip} HEAD${args.symrefs ? ' symref-target:refs/heads/' + repo.defaultBranch : ''}\n`);
    } else {
      lines.push(`unborn HEAD${args.symrefs ? ' symref-target:refs/heads/' + repo.defaultBranch : ''}\n`);
    }
  }
  for (const ref of all) {
    if (ref.name === 'HEAD') continue;
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const peeled = peeledCommit(store, ref.oid);
      if (peeled !== undefined && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
}

function parseV2Args(packets: ReturnType<typeof decodePktLines>['packets']): {
  command: string;
  args: string[];
} {
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    if (!pastDelim) {
      if (text.startsWith('command=')) command = text.slice('command='.length).trim();
      continue;
    }
    args.push(text);
  }
  return { command, args };
}

export function handleUploadPack(store: ForgeStore, req: GitRequest): GitResponse {
  const repo = store.getRepo(req.owner, req.repo);
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
  }
  store.learnViewer(req.owner);
  const resultType = 'application/x-git-upload-pack-result';
  const isV2 = req.headers['git-protocol'] === 'version=2';
  try {
    if (isV2) {
      const { packets } = decodePktLines(req.body);
      const { command, args } = parseV2Args(packets);
      if (command === 'ls-refs') {
        const opts = { peel: false, symrefs: false, prefixes: [] as string[] };
        for (const arg of args) {
          const text = arg.replace(/\n$/, '');
          if (text === 'peel') opts.peel = true;
          else if (text === 'symrefs') opts.symrefs = true;
          else if (text.startsWith('ref-prefix ')) opts.prefixes.push(text.slice('ref-prefix '.length));
        }
        return { status: 200, contentType: resultType, body: lsRefsResponseV2(store, repo, opts) };
      }
      if (command !== 'fetch') {
        return { status: 400, contentType: 'application/json', body: Buffer.from('{"message":"unknown command"}\n', 'utf8') };
      }
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | undefined;
      for (const arg of args) {
        const text = arg.replace(/\n$/, '');
        if (text.startsWith('want ')) wants.push(text.slice(5).trim());
        else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
        else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
      }
      const selection = selectFetch(store, wants, haves, shallow, depth);
      return { status: 200, contentType: resultType, body: fetchResponseV2(selection) };
    }
    // Protocol v0 fetch.
    const { packets } = decodePktLines(req.body);
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | undefined;
    let seenFlush = false;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        seenFlush = true;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      if (text.startsWith('want ')) {
        const rest = text.slice(5).trim();
        wants.push(rest.split(' ')[0]!);
      } else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
      else if (seenFlush && text.startsWith('have ')) haves.push(text.slice(5).trim());
    }
    const selection = selectFetch(store, wants, haves, shallow, depth);
    const parts: Buffer[] = [];
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    if (selection.acks.length > 0) {
      for (const ack of selection.acks) parts.push(pktLine(`ACK ${ack}\n`));
    } else if (haves.length > 0) {
      parts.push(pktLine('NAK\n'));
    }
    const pack = writePack(selection.objects);
    for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
    parts.push(pktFlush());
    return { status: 200, contentType: resultType, body: Buffer.concat(parts) };
  } catch (err) {
    return {
      status: 400,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ message: err instanceof Error ? err.message : 'bad request' }) + '\n', 'utf8'),
    };
  }
}

// ---------------------------------------------------------------------------
// receive-pack v0
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function reportPacket(lines: string[], sideband: boolean): Buffer {
  const inner = Buffer.concat(lines.map((line) => pktLine(line)));
  if (!sideband) return Buffer.concat([inner, pktFlush()]);
  const parts: Buffer[] = [];
  for (const packet of sidebandPackets(inner, 1)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleReceivePack(store: ForgeStore, req: GitRequest): GitResponse {
  const repo = store.getRepo(req.owner, req.repo);
  const resultType = 'application/x-git-receive-pack-result';
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
  }
  store.learnViewer(req.owner);
  const owner = repo.owner ?? req.owner;
  let commands: PushCommand[] = [];
  let sideband = false;
  let packBytes = Buffer.alloc(0);
  try {
    const { packets, rest } = splitAtFlush(req.body);
    packBytes = rest;
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      let text = packet.payload.toString('utf8');
      const nul = text.indexOf('\0');
      let caps = '';
      if (nul >= 0) {
        caps = text.slice(nul + 1);
        text = text.slice(0, nul);
        if (caps.includes('side-band-64k')) sideband = true;
      }
      const line = text.replace(/\n$/, '');
      const parts = line.split(' ');
      if (parts.length !== 3) throw new Error(`bad push command: ${JSON.stringify(line)}`);
      const [oldOid, newOid, ref] = parts as [string, string, string];
      if (!isOid(oldOid) || !isOid(newOid) || !ref.startsWith('refs/')) {
        throw new Error(`bad push command: ${JSON.stringify(line)}`);
      }
      commands.push({ oldOid, newOid, ref });
    }
    if (commands.length === 0) throw new Error('no push commands');
  } catch (err) {
    return {
      status: 400,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ message: err instanceof Error ? err.message : 'bad request' }) + '\n', 'utf8'),
    };
  }

  // Unpack: every object in the pack joins the store (deltas resolve against
  // the pack itself and against objects already stored).
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, { resolveBase: (oid) => store.getObject(oid) });
      for (const object of objects) store.putObject(object.type, object.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  if (unpackOk) {
    for (const command of commands) {
      const result = applyPushCommand(store, owner, repo.name, command);
      reportLines.push(result.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${result.reason}\n`);
    }
  } else {
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
  }
  return { status: 200, contentType: resultType, body: reportPacket(reportLines, sideband) };
}

function applyPushCommand(
  store: ForgeStore,
  owner: string,
  repoName: string,
  command: PushCommand,
): { ok: boolean; reason?: string } {
  const current = store.getRef(owner, repoName, command.ref);
  if (command.newOid === ZERO_OID) {
    // A delete.
    if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      return { ok: false, reason: 'non-fast-forward' };
    }
    store.deleteRef(owner, repoName, command.ref);
    return { ok: true };
  }
  if (store.getObject(command.newOid) === undefined) {
    return { ok: false, reason: 'object not found' };
  }
  if (command.ref.startsWith('refs/heads/')) {
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) return { ok: false, reason: 'non-fast-forward' };
      store.setRef(owner, repoName, command.ref, command.newOid);
      return { ok: true };
    }
    if (command.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
    if (command.newOid === current) return { ok: true };
    if (!store.isAncestor(current, command.newOid)) return { ok: false, reason: 'non-fast-forward' };
    store.setRef(owner, repoName, command.ref, command.newOid);
    return { ok: true };
  }
  // Tags and other refs: create or move when the old value matches.
  if (current !== undefined && command.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
  if (current === undefined && command.oldOid !== ZERO_OID) return { ok: false, reason: 'non-fast-forward' };
  store.setRef(owner, repoName, command.ref, command.newOid);
  return { ok: true };
}
