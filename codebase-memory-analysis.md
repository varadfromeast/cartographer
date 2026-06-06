# Technical Analysis: Potential Product Shape of Cartographer Inspired by `codebase-memory-mcp`

## Decision Note: Copy / Adapt / Avoid

Probe date: 2026-06-06.

Local probe target:

- Binary: `/Users/varad/.local/bin/codebase-memory-mcp`
- Version: `0.6.0`
- Cache: `/Users/varad/.cache/codebase-memory-mcp`
- Cartographer project DB: `Users-varad-V-repo-cartographer.db`

Probe commands exercised:

- `index_repository` indexed this repo into `1665` nodes and `4378` edges.
- `get_graph_schema` reported node labels, edge types, and missing ADR state.
- `search_graph` found graph/topology symbols through BM25 search.
- `query_graph` returned direct call edges from `resolveExplorationTopology`.
- `trace_path` returned caller/callee neighborhoods for `findExplorationPath` and `resolveExplorationTopology`.
- `detect_changes` reported no changed files immediately after indexing.
- SQLite inspection confirmed `nodes`, `edges`, `file_hashes`, FTS, `node_vectors`, and `token_vectors`.

### Copy

- Use a local SQLite database as the durable graph store, not a remote graph service.
- Use a relational property-graph shape: stable vertices, adjacency-list edges, JSON properties for long-tail metadata, and indexes by project/domain, node identity, source, target, and edge type.
- Use WAL mode for concurrent CLI readers and occasional writers.
- Keep file hashes or content hashes beside graph rows so incremental updates can detect drift cheaply.
- Add FTS for deterministic text search before adding embeddings.
- Keep compact vector blobs as an optional later acceleration, not as the first storage milestone.

### Adapt

- Cartographer's primary vertices should be `surfaces`, not generic code `nodes`.
- Cartographer's primary edges should be `actions`, with explicit risk, binding, verification, and target-status fields.
- `controls` and `action_bindings` should be separate from actions so selector drift does not rewrite the logical graph edge.
- Heavy evidence should stay on disk. SQLite should store paths, hashes, summaries, current binding state, graph status, and event history.
- Append-only `graph_events` should be the audit source for graph mutation; current tables can be materialized views over those events once the basic store is proven.
- WAL settings need to be validated under Cartographer's real CLI concurrency. The probed DB uses WAL and default `wal_autocheckpoint=1000`, but `busy_timeout=0`, `mmap_size=0`, and `foreign_keys=0` from a plain SQLite connection are not sufficient product decisions.

### Avoid

- Do not copy the code graph schema directly. Code symbols and browser surfaces have different identity, risk, and evidence requirements.
- Do not make embeddings part of the initial correctness path. Deterministic URL, title, heading, label, action-kind, risk, and target-status search should come first.
- Do not migrate browser leases into SQLite in the first pass. Keep the current profile lock until SQLite write behavior is tested with concurrent Cartographer commands.
- Do not store screenshots, full HTML, accessibility trees, markdown blobs, or large evidence payloads in SQLite.
- Do not replace `graph-candidate.json` immediately. First add `SiteGraphStore`, a JSON-backed adapter, and a SQLite-backed adapter with compatibility exports.

Immediate implementation implication: Point 3 and Point 4 are the next safe code changes. Define the storage-neutral graph contract and store interface first, then add a SQLite adapter behind that interface. Harness rewiring, recursive SQL traversal, watch mode, embeddings, browser leases, and generated skill changes should wait.

---

This analysis outlines the technical findings from our live probe of the `codebase-memory-mcp` database structure and details how these patterns can reform the architecture of **Cartographer** to replace the file-heavy, synchronous "harness" model.

---

## 1. Technical Findings: `codebase-memory-mcp` Internals

`codebase-memory-mcp` operates as a local-first, high-performance graph indexer. Rather than using an external graph server or flat files, it stores the code graph in a local SQLite database file (`~/.cache/codebase-memory-mcp/[project-name].db`).

```text
                                  ┌────────────────────────────────┐
                                  │   SQLite Database Engine       │
                                  ├────────────────────────────────┤
                                  │   nodes         node_vectors   │
                                  │   edges         token_vectors  │
                                  │   file_hashes   projects       │
                                  └───────────────┬────────────────┘
                                                  │
                                          cbm_cosine_i8()
                                                  │
                                                  ▼
                                ┌──────────────────────────────────┐
                                │ Custom C/Rust SQLite Extension   │
                                │ (Quantized INT8 Dot-Product SIMD)│
                                └──────────────────────────────────┘
```

### 1.1 SQLite Table Schema

The physical structure represents a Directed Property Graph using a relational adjacency list:

- **`nodes` Table:** Vertex list indexing AST code symbols.
  - `id` (INTEGER, Primary Key): Stable reference.
  - `project` (TEXT): Scopes multi-project setups.
  - `label` (TEXT): Category matching Tree-sitter AST nodes (`Folder`, `File`, `Class`, `Function`, `Method`, `Route`, `Type`, `Interface`).
  - `name` / `qualified_name` (TEXT): Symbol identifier (e.g. class namespace or route path).
  - `file_path` (TEXT), `start_line` / `end_line` (INTEGER): Location mapping.
  - `properties` (TEXT JSON): Stores variable parameters, signature structures, and docstrings.
- **`edges` Table:** Adjacency list indexing static/semantic connections.
  - `id` (INTEGER, Primary Key)
  - `project` (TEXT)
  - `source_id` / `target_id` (INTEGER): Foreign keys pointing to `nodes.id`.
  - `type` (TEXT): Relationship label (`DEFINES`, `USAGE`, `CALLS`, `TESTS`, `SEMANTICALLY_RELATED`, `WRITES`, `DEFINES_METHOD`, `IMPORTS`, `CONTAINS_FILE`, `CONTAINS_FOLDER`, `CONFIGURES`, `SIMILAR_TO`, `TESTS_FILE`, `HTTP_CALLS`, `DECORATES`, `RAISES`).
  - `properties` (TEXT JSON): Edge weights or attributes.
- **`node_vectors` Table:** Quantized embedding storage.
  - `node_id` (INTEGER, Foreign Key)
  - `project` (TEXT)
  - `vector` (BLOB): **768-byte BLOB** representing 768-dimensional `int8` embeddings.

### 1.2 Int8 Quantization & Vector Similarity

To calculate semantic similarity without memory overhead:

- **Dimensionality:** 768 dimensions using `nomic-embed-code`.
- **Quantization:** Float embeddings $[-1.0, 1.0]$ are quantized to 8-bit signed integers ($[-128, 127]$).
- **CPU Optimization:** SQLite loads a custom extension function `cbm_cosine_i8(query_vector, target_vector)`. This function calculates the dot product using SIMD (Single Instruction Multiple Data) assembly instructions on the CPU, comparing vectors in parallel without floating-point conversion.
- **Per-Keyword Min-Cosine:** For queries with multiple keywords, the engine calculates the similarity score of each keyword vector against the node vector independently, selecting the **minimum** score. This enforces a semantic `AND` constraint.

### 1.3 Concurrency & Stability Configurations

Because multiple sessions might query the index simultaneously, `codebase-memory-mcp` configures SQLite to prevent locking and corruption:

- **PASSIVE Checkpointing:** Switches WAL checkpointing from `SQLITE_CHECKPOINT_TRUNCATE` to `SQLITE_CHECKPOINT_PASSIVE`. This ensures that checkpointing doesn't truncate the WAL file while other readers hold active read transactions, avoiding `SIGBUS` errors.
- **Memory-Map Tuning (`mmap_size`):** Controls memory-mapped I/O size to avoid stale shared memory (`.shm`) recovery and concurrent lock races during high write throughput.

---

## 2. Reshaping Cartographer: From "Harness" to Database-Driven Crawler

Cartographer currently uses an exploration harness that logs sequential crawl steps to flat files, writing screenshots, Markdown compiles, AX trees, and control diffs to disk on every step. This makes crawling slow and I/O-bound.

By implementing the SQLite adjacency graph and quantization patterns, Cartographer can be redesigned as a high-performance web crawler and semantic site graph.

### 2.1 The SQLite Site-Graph Schema (`site-graph.db`)

We can replace the directories of `surface.json` and `graph-candidate.json` files with a single SQLite file containing the following indexed tables:

```sql
-- Vertices representing unique web surfaces (pages/states)
CREATE TABLE nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  url_shape TEXT NOT NULL UNIQUE, -- Normalized URL path (e.g., 'x.com/messages')
  surface_type TEXT NOT NULL,     -- Classified category (e.g., 'linkedin_messaging')
  title TEXT,
  capture_id TEXT NOT NULL,
  surface_hash TEXT NOT NULL,     -- Content footprint hash
  screenshot_path TEXT,
  markdown_path TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Edges representing interactive controls and transitions
CREATE TABLE edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_node_id INTEGER NOT NULL,
  target_node_id INTEGER,         -- NULL if uncaptured same-domain target
  label TEXT NOT NULL,            -- Visible element text or name
  action_kind TEXT NOT NULL,      -- 'navigate', 'click', 'input', 'select'
  write_risk TEXT NOT NULL,       -- 'none', 'possible', 'destructive'
  href TEXT,                      -- Link target URL
  control_stable_id TEXT NOT NULL,-- SHA-256 footprint of control
  selector_json TEXT NOT NULL,    -- Array of selector candidates (CSS, role)
  target_status TEXT NOT NULL,    -- 'known', 'self', 'uncaptured', 'external', 'write_risk'
  priority INTEGER DEFAULT 1,
  properties TEXT DEFAULT '{}',   -- Rect coordinates, landmark, heading
  FOREIGN KEY(source_node_id) REFERENCES nodes(id),
  FOREIGN KEY(target_node_id) REFERENCES nodes(id)
);

-- Node and control vector embeddings for semantic search
CREATE TABLE node_embeddings (
  node_id INTEGER,
  control_id INTEGER,             -- NULL if embedding represents the whole page
  vector BLOB NOT NULL,           -- 768-byte quantized int8 BLOB
  FOREIGN KEY(node_id) REFERENCES nodes(id),
  FOREIGN KEY(control_id) REFERENCES edges(id)
);

CREATE INDEX idx_nodes_url_shape ON nodes(url_shape);
CREATE INDEX idx_edges_source ON edges(source_node_id);
CREATE INDEX idx_edges_target ON edges(target_node_id);
CREATE INDEX idx_edges_status ON edges(target_status);
```

### 2.2 Graph Traversals via SQL

Checking reachability and paths in the web graph no longer requires loading a massive JSON file in memory. A recursive SQL query (CTE) can compute path traversal instantly:

```sql
-- Find a safe navigation path from Home to Direct Thread using SQLite CTE
WITH RECURSIVE bfs_path(node_id, path_str, depth) AS (
  SELECT id, url_shape, 0
  FROM nodes
  WHERE url_shape = 'instagram.com/'

  UNION ALL

  SELECT e.target_node_id, bp.path_str || ' -> ' || n.url_shape, bp.depth + 1
  FROM bfs_path bp
  JOIN edges e ON bp.node_id = e.source_node_id
  JOIN nodes n ON e.target_node_id = n.id
  WHERE e.target_status = 'known'
    AND e.write_risk = 'none'
    AND bp.depth < 5 -- Max path depth limit
)
SELECT path_str, depth FROM bfs_path WHERE path_str LIKE '%/direct/t/%' LIMIT 1;
```

### 2.3 Solving Concurrency & Profiling Lock

The current browser-lock pattern uses filesystem lock files (`withBrowserProfileLock`) and lease JSON files (`TaskBrowserLease` in `browser-session.json`).

We can migrate these leases to a transactional lock table inside the SQLite database, using SQLite's native transaction mechanism to coordinate browser profiles across multiple processes:

```sql
CREATE TABLE browser_leases (
  profile_name TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  leased_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL
);
```

Acquiring a lease is resolved via a single atomic statement:

```sql
INSERT OR REPLACE INTO browser_leases (profile_name, task_id, owner_pid, expires_at)
VALUES ('default', 'task_101', 8271, datetime('now', '+30 seconds'))
WHERE NOT EXISTS (
  SELECT 1 FROM browser_leases
  WHERE profile_name = 'default'
    AND expires_at > datetime('now')
    AND owner_pid != 8271
);
```

### 2.4 Semantic Navigation & Selector Drift Reconciliation

By storing quantized vectors of page content and button labels, Cartographer gains semantic resilience against website changes:

```text
Crawl Run (Page Layout updated)
  │
  ├─► Crawled Button: "Send Message" (CSS Path: "div > span.btn-text-v2")
  │
  ├─► Fetch Node Embeddings from site-graph.db
  │     Vector Query: "Send Message"
  │
  └─► Compare Cosine Similarity (cbm_cosine_i8)
        Match Found: Old Node "Send" (CSS Path: "div > button.btn-send")
        Action: Automatically update target selector to "div > span.btn-text-v2"
```

1.  **Semantic Search:** AI agents can search the site graph using natural language (e.g. asking for "direct inbox" or "user profile settings"). The SQLite engine uses `cbm_cosine_i8` to resolve the query to the correct node ID, even if the node's URL shape doesn't match the query.
2.  **Selector Drift Reconciliation:** Websites frequently update button classes and DOM layouts, which breaks hardcoded selectors. When the crawler visits a page and finds a modified control, it can compare the semantic vector of the new control's text/role against the page's existing edges. If it finds a match, it updates the `selector_json` in the database, preserving the edge connection.
