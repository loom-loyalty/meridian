# Meridian Skill Declaration Specification

**Version:** 1.0.0-draft.1
**Status:** Draft
**Date:** April 2026
**License:** CC BY 4.0

---

## 1. Purpose

This specification defines how agents declare their capabilities within a Meridian system. Skills are the unit of capability: what an agent can do, what it costs, what runtime it needs, and how other agents or systems can discover it.

---

## 2. Progressive disclosure model

Skills use a three-stage progressive disclosure model to minimize token consumption and startup cost.

### Stage 1: Discovery

Loaded at system startup for all agents. Must be lightweight (target: under 100 tokens per agent).

Contains:
- `name` — human-readable skill name
- `description` — what this agent does (1-2 sentences)
- `domains` — which domains this agent participates in
- `capabilities` — list of capability tags for matching (e.g., `["query_optimization", "index_management"]`)
- `costEstimate` — approximate cost per invocation in USD
- `runtimeRequirements` — what runtime class this agent needs (optional, experimental)

### Stage 2: Activation

Loaded when the skill is selected for use. Target: under 5,000 tokens.

Contains:
- Full capability manifest with input/output contracts
- Tool declarations (what tools this agent uses)
- Cost breakdown per action type
- Permission requirements (what `PermissionScope` this agent needs)
- Dependencies on other agents or services

### Stage 3: Runtime

Loaded on demand during execution. No token limit (loaded into agent context as needed).

Contains:
- Full system prompt and behavioral instructions
- Domain-specific playbooks and decision trees
- Reference documentation, schemas, and examples
- Active context and loaded resources

---

## 3. Skill routing

Skills are discovered and loaded through routing rules. Two patterns:

**Self-selected routing.** The agent's system prompt contains a routing table mapping request patterns to skills. The agent reads the table and loads only the skills it needs per task. This is the pattern for generalist agents handling diverse requests. Example:

```
- Session investigation → load `investigate-session`
- Code change request → load `create-pr`
- Customer data query → load `data-warehouse` + `customer-intelligence`
```

**System-routed.** The orchestration layer examines the incoming message or work item and pre-loads the appropriate skills based on domain, work item type, or invocation source. This is the pattern for specialized agents in a mesh topology.

In both patterns, only Stage 1 metadata is loaded at routing time. Stage 2 and Stage 3 load on demand.

---

## 4. Skill declaration format

Skills are declared in YAML or JSON. The format is designed to be human-readable and machine-parseable.

```yaml
name: postgres-query-optimizer
version: 1.2.0
description: Analyzes query performance, detects hot queries, and suggests index optimizations.

domains:
  - infrastructure

capabilities:
  - query_optimization
  - index_management
  - performance_analysis

costEstimate:
  perInvocation: 0.03
  currency: USD

runtimeRequirements:
  class: any
  filesystem: false
  shell: false

tools:
  - name: queryMetrics
    description: Fetch query performance metrics from the database
  - name: explainPlan
    description: Run EXPLAIN ANALYZE on a query
  - name: suggestIndex
    description: Analyze query patterns and suggest indexes

permissions:
  services:
    - "database.queryMetrics"
    - "database.explainPlan"
    - "database.suggestIndex"

feedback:
  emits:
    required: [heartbeat, cost, errors, dependencies]
    expected: [metrics_with_baselines, insights_with_confidence]
    optional: [quality, competing_context, pattern_recognition]
```

---

## 5. Versioning

Skills follow semantic versioning. When a skill updates:

- Patch versions (1.2.0 → 1.2.1): bug fixes, documentation improvements. Agents auto-adopt.
- Minor versions (1.2.0 → 1.3.0): new capabilities added. Agents discover on next routing cycle.
- Major versions (1.x → 2.x): breaking changes to inputs/outputs. Agents must explicitly opt in.

The marketplace layer (outside this spec) handles discovery, curation, and trust scoring for published skills.

---

## 6. Skill file conventions

Skills may be declared as:
- A single YAML/JSON file (e.g., `skill.yaml`)
- A directory with `skill.yaml` at the root and supporting files (playbooks, schemas, examples) alongside it
- A `SKILL.md` file following the Markdown-based convention (compatible with existing ecosystem patterns)

Meridian runtimes scan conventional directories for skill declarations:
- `~/.meridian/skills/` for user-level skills
- `.meridian/skills/` for project-level skills
- Registry endpoints for published marketplace skills

---

*Draft document. Comments welcome via pull request.*
