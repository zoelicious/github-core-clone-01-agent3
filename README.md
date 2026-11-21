# forge-disk — a GitHub-compatible git forge

A single-process Node 22 (stdlib only, no dependencies, no git binary) forge for the
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01) competition.
Referral: https://make.fun/r/nmy46sr8

## What it serves

| Route | Surface |
| --- | --- |
| `GET /healthz` | Boot probe, `200 {"ok":true}` |
| `/<owner>/<repo>.git/...` | git smart HTTP — upload-pack protocol v2 (clone/fetch, incl. shallow), receive-pack v0 (push) |
| `/api/v3/...` | GitHub REST v3 — repositories, branches, commits, contents, labels, issues, comments, pull requests, merges |
| `POST /api/graphql` | GitHub GraphQL v4 — the documents `gh` and `github-mcp-server` send, plus introspection |
| `POST /mcp` | Model Context Protocol, streamable HTTP, revision 2026-07-28 (`server/discover`) with the 2025-11-25 handshake as fallback |

## How it stores things

Objects live on disk, content-addressed, as loose zlib objects under the store
directory (`$FORGE_STORE_DIR`, default `<tmp>/makefun-forge-store`), exactly like
git's own loose-object layout: `.forge/objects/xx/<sha1>`. Refs are small files
under the same store. A small in-memory LRU keeps hot objects out of the disk
path, so a clone of an already-stored pack is served again without rebuilding
anything from scratch. Repository metadata (issues, pull requests, labels) lives
in memory; git objects and refs are the durable part.

Packs arriving on push are parsed in a streaming pass (objects are inflated and
stored one at a time, never held whole in memory as a second copy), and packs
served on fetch are built object by object with no delta compression — every
object's SHA-1 recomputes to its id, so a clone is verifiable byte for byte.

## Lifecycle

`main.ts` binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`,
then polls `$MAKEFUN_ENV_URL/done` until the trial is over and exits 0. It never
binds 8080 (the env owns it).

## Run it

```sh
node main.ts            # needs MAKEFUN_ENV_URL to register against
```

No install step, no network, no clock and no unseeded randomness in any stored
state: commit timestamps come from a fixed epoch plus a deterministic counter,
so two runs of the same request sequence leave identical state.

## Layout

- `main.ts` — the entry/env lifecycle (bind, register, wait for done)
- `app.ts` — the HTTP server and router
- `git.ts` — object hashing, pack reading/writing, pkt-line framing, commit/tree parsing
- `store.ts` — the forge store: on-disk objects and refs, in-memory repo metadata
- `githttp.ts` — smart-HTTP handlers (info/refs, upload-pack v2/v0, receive-pack)
- `rest.ts` — REST v3 handlers
- `graphql.ts` — a small GraphQL parser and executor for the v4 documents
- `mcp.ts` — the MCP endpoint and its tools
