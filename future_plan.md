# Cartographer Future Architecture Plan

This document outlines major paradigm-shifting improvements designed to scale Cartographer from a local deterministic CLI utility to an enterprise-grade, self-healing fleet orchestrator, culminating in an Automatic Website API Generator.

## 1. Parallel Task Orchestration (Session Pooler)

**Current State:**
Cartographer runs tasks sequentially. Each execution spins up or attaches to a browser, processes a linear tape, and closes.

**The Vision:**
Implement a "Session Pooler" that orchestrates multiple Cartographer instances in parallel, safely managing headless browser profiles and shared state across multiple workers.

**Key Benefits:**
- **Massive Scale:** Move from running 1 task to running 100+ tasks concurrently across a cluster of local or remote browsers.
- **Resource Efficiency:** Avoid the CPU and memory spikes of constantly cold-starting Chromium instances by maintaining a pool of "warm" browser contexts.
- **State Safety:** Prevent data corruption by properly locking and injecting shared profile data (like login cookies and local storage) into isolated browser contexts upon checkout from the pool.

---

## 2. State-Aware Branching (FSM-based Tapes)

**Current State:**
The `ProcessTape` is a linear sequence (`Step 1 -> Step 2 -> Step 3`). If the target UI introduces an unexpected detour—such as an intermittent A/B test, a "Security Check", or a "Verify Email" modal—the linear tape strictly fails.

**The Vision:**
Evolve the linear tape into a **State Transition Graph** (Finite State Machine). Instead of executing rigid steps, the system dynamically identifies its current state via existing `StateIdentity` fingerprinting and calculates the required transition to reach the desired state.

**Key Benefits:**
- **Self-Healing Execution:** If Cartographer expects to be `in_inbox` but wakes up in an `unverified_email_checkpoint` state, it can dynamically query the graph for an acquired `dismiss_email_verification` skill, execute it, and organically transition back to the target path.
- **A/B Test Resilience:** The engine is no longer fragile to minor navigational detours; it simply recalculates the path based on the current mathematical state hash.
- **Dynamic Skill Composition:** Transforms the skill library into a traversable Knowledge Graph of the UI.

---

## 3. Active Site Explorer & CLI/Graph Generator (Agentic Site Mapping)

**Current State:**
Cartographer learns lazily. It only acquires a skill if an agent explicitly attempts a task, fails, uses fallback, and creates "learning debt."

**The Vision:**
Deploy an **Active Explorer Agent** whose sole job is to systematically spider and map a target UI. It clicks buttons, identifies states using `StateIdentity` hashes, and automatically builds a comprehensive Graph (FSM). This graph is then exposed as both a visual UI and an instant, deterministic SDK for downstream agents.

**Implementation Phases:**
1. **The Discovery Loop (Crawler):** The LLM-powered explorer loads a site, extracts interactive elements, records the current `StateIdentity` (Node), interacts with an element, and records the resulting deterministic CLI command (Edge) and new `StateIdentity`.
2. **Graph Construction (`graph.json`):** A mathematical graph is built mapping every state and transition. The LLM is used *only once* to assign semantic labels to discovered states (e.g., "Settings Page").
3. **The Visualizer UI (Human-in-the-Loop):** A local React Flow/Cytoscape web UI renders `graph.json`. Developers can visually inspect the map, delete dead-end branches (e.g., "Terms of Service modal"), or manually stitch missing transitions, pruning the graph of noise.
4. **Agent Pathfinding Engine (The Router):** Downstream agents no longer navigate the DOM. They provide a target state (e.g., "reset password"). Cartographer runs Dijkstra’s algorithm on the graph to find the shortest path from the current browser hash to the target node, outputting and executing an exact, deterministic array of CLI commands.

**Key Benefits:**
- **Turns any GUI into an API:** You point an explorer at a SaaS dashboard on Friday, and by Monday you have a full deterministic SDK mapping the entire site capability set.
- **Near-Zero Inference Costs at Runtime:** LLM tokens are only spent during the active exploration phase. Production workflows use pathfinding algorithms, making execution instant and virtually free.
