// Git object primitives: hashing, loose-object bytes, packfiles, pkt-line
// framing, and commit/tree parsing and building. Everything here is pure
// byte work over Node's stdlib (crypto, zlib) — no git binary, no deps.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** SHA-1 of `<type> <size>\0<data>`, the object id git assigns. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** The loose-object bytes git stores on disk: zlib of `<type> <size>\0<data>`. */
export function encodeLoose(type: GitObjectType, data: Uint8Array): Buffer {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return deflateSync(Buffer.concat([head, Buffer.from(data)]));
}

/** Parse loose-object bytes back into type and data. */
export function decodeLoose(bytes: Buffer): GitObject {
  const raw = inflateSync(bytes);
  const nul = raw.indexOf(0);
  if (nul < 0) throw new Error('loose object has no header terminator');
  const header = raw.subarray(0, nul).toString('utf8');
  const space = header.indexOf(' ');
  const type = header.slice(0, space) as GitObjectType;
  const size = Number(header.slice(space + 1));
  if (!CODE_TYPES[TYPE_CODES[type]] || raw.length - nul - 1 !== size) {
    throw new Error(`loose object header is corrupt: ${JSON.stringify(header)}`);
  }
  return { type, data: Buffer.from(raw.subarray(nul + 1)) };
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  readonly kind: PktKind;
  /** The payload of a data packet (without its length prefix). Empty otherwise. */
  readonly payload: Buffer;
}

/** One pkt-line: 4 hex digits of total length, then the payload. */
export function pktLine(payload: string | Uint8Array): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Encode a list of lines (strings) plus 'flush'/'delim' markers into pkt-lines. */
export function encodePktLines(lines: readonly (string | 'flush' | 'delim' | 'response-end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else if (line === 'response-end') parts.push(pktResponseEnd());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/**
 * Decode a whole buffer of pkt-lines. Throws on a malformed length prefix so a
 * garbage POST is a 400, never a crash. `allowTrailing` lets a pack follow the
 * flush line (receive-pack bodies carry the pack after the command list).
 */
export function decodePktLines(bytes: Buffer, allowTrailing = false): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('pkt-line is truncated');
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`not a pkt-line: ${JSON.stringify(head)}`);
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > bytes.length) throw new Error('pkt-line length is out of range');
    packets.push({ kind: 'data', payload: Buffer.from(bytes.subarray(offset + 4, offset + len)) });
    offset += len;
  }
  void allowTrailing;
  return { packets, rest: Buffer.alloc(0) };
}

/** Split a buffer at the first flush packet: packets before it, bytes after it. */
export function splitAtFlush(bytes: Buffer): { packets: Pkt[]; rest: Buffer } {
  let offset = 0;
  const packets: Pkt[] = [];
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('pkt-line is truncated');
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`not a pkt-line: ${JSON.stringify(head)}`);
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, rest: Buffer.from(bytes.subarray(offset + 4)) };
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > bytes.length) throw new Error('pkt-line length is out of range');
    packets.push({ kind: 'data', payload: Buffer.from(bytes.subarray(offset + 4, offset + len)) });
    offset += len;
  }
  return { packets, rest: Buffer.alloc(0) };
}

// ---------------------------------------------------------------------------
// commit / tree / tag
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headEnd = blank < 0 ? buffer.length : blank;
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of buffer.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error('tag header has no value');
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode');
    const nul = buffer.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries ordered by name, directories as if named `name/`. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0,
  );
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build a commit object's bytes. `message` is stored with a trailing newline. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const who = (identity: string): string => `${identity} ${fields.timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who(fields.author)}`, `committer ${who(fields.committer)}`, '');
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

function readPackVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset, end);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: Buffer.from(result.buffer), next: offset + written };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.from(base);
  const deltaBuffer = Buffer.from(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new Error('delta size varint is truncated');
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy offset is truncated');
          copyOffset += deltaBuffer[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy size is truncated');
          copySize += deltaBuffer[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackObject {
  oid: string;
  type: GitObjectType;
  data: Buffer;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including
 * OFS_DELTA and REF_DELTA entries. `resolveBase` supplies a base object a thin
 * pack leaves out (an object the receiver already holds). Every object's
 * SHA-1 is recomputed and its declared size checked.
 */
export function readPack(
  pack: Uint8Array,
  options: { resolveBase?: (oid: string) => GitObject | undefined } = {},
): PackObject[] {
  const buffer = Buffer.from(pack);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (buffer.subarray(trailerStart).toString('hex') !== computedTrailer) {
    throw new Error('pack trailer checksum does not match its bytes');
  }
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPES[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer, offset, trailerStart);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const resolved = new Map<number, PackObject>();
  const resolving = new Set<number>();
  const resolveEntry = (entry: RawPackEntry): PackObject => {
    const cached = resolved.get(entry.offset);
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('pack delta cycle');
    resolving.add(entry.offset);
    try {
      if (entry.typeCode === 6 || entry.typeCode === 7) {
        let base: PackObject;
        if (entry.typeCode === 6) {
          const baseEntry = byOffset.get(entry.baseOffset!);
          if (!baseEntry) throw new Error('ofs-delta base is outside the pack');
          base = resolveEntry(baseEntry);
        } else {
          const inPack = raw.find((candidate) => {
            if (candidate.typeCode === 6 || candidate.typeCode === 7) return false;
            return hashObject(CODE_TYPES[candidate.typeCode]!, candidate.data) === entry.baseOid;
          });
          if (inPack) {
            base = resolveEntry(inPack);
          } else {
            const external = options.resolveBase?.(entry.baseOid!);
            if (!external) throw new Error(`ref-delta base ${entry.baseOid} is not in the pack or the store`);
            base = { oid: entry.baseOid!, type: external.type, data: Buffer.from(external.data) };
          }
        }
        const data = applyDelta(base.data, entry.data);
        const obj: PackObject = { oid: hashObject(base.type, data), type: base.type, data };
        resolved.set(entry.offset, obj);
        return obj;
      }
      const type = CODE_TYPES[entry.typeCode]!;
      const obj: PackObject = { oid: hashObject(type, entry.data), type, data: entry.data };
      resolved.set(entry.offset, obj);
      return obj;
    } finally {
      resolving.delete(entry.offset);
    }
  };
  return raw.map((entry) => resolveEntry(entry));
}

/** Build a packfile from plain objects (no deltas), in the given order. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = Buffer.from(object.data);
    const code = TYPE_CODES[object.type];
    const bytes: number[] = [];
    let remaining = data.length;
    let first = (code << 4) | (remaining & 0x0f);
    remaining = Math.floor(remaining / 16);
    while (remaining > 0) {
      bytes.push(first | 0x80);
      first = remaining & 0x7f;
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(first);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Verify a pack's trailer checksum without parsing its entries. */
export function packChecksumOk(pack: Uint8Array): boolean {
  const buffer = Buffer.from(pack);
  if (buffer.length < 20) return false;
  return (
    buffer.subarray(buffer.length - 20).toString('hex') ===
    createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest('hex')
  );
}
