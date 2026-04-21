# Meridian Domain Model Specification

**Version:** 1.0.0-draft.1
**Status:** Draft
**Date:** April 2026
**License:** CC BY 4.0

> Meridian is the protocol for systems where agents operate, humans steward, and costs are visible in real time. It defines the wire format, runtime primitives, feedback contract, and skill declaration that let mixed agent-and-human organizations run lean — small teams of stewards setting direction and gating decisions, while domain agents handle operational work within visible budgets.

This document defines the Meridian domain model: domains as accountability-based organizational primitives, the steward role, visible budgets, quality gates, and cross-domain work. Domain adoption is an operating pattern; see the [`README.md`](README.md) in this directory for the core/patterns boundary.

---

## 1. Purpose

This specification defines the domain model for Meridian systems. Domains are the organizational primitive. They replace departments, teams, and reporting hierarchies with a structure designed for mixed human-and-agent workforces.

---

## 2. What a domain is

A domain is a named area of accountability. "Infrastructure." "Revenue." "User Experience." "Compliance." "Data." "Security."

A domain is NOT a team. It is not defined by who reports to whom. It is defined by what outcomes it's responsible for.

---

## 3. Required properties

Every domain must have:

**An identifier and name.** Unique within the Meridian system.

**At least one human steward.** A steward owns three things: the domain's budget, the domain's quality gates, and the domain's strategic direction. Stewards are humans, never agents. A domain may have multiple stewards designated as `primary` or `secondary`.

**A visible budget.** Real-time cost attribution from all participating components. The budget has a monthly limit in USD, current spend, and an alert threshold (fraction of limit that triggers a warning).

---

## 4. Membership

Agents and humans participate in domains. Participation is declared, not inherited. Key properties:

- An agent or human can participate in **multiple domains simultaneously.** A Postgres agent might participate in Infrastructure and Revenue. A human engineer might participate in Product and Security.
- Participation has a role: `participant` (can pull work, emit feedback, propose changes) or `observer` (can view but not act).
- Membership is dynamic. Agents can be added to or removed from domains at runtime.

---

## 5. Gates

Stewards configure quality gates per domain. A gate specifies:

- Which work item types it applies to (e.g., "all stories," "architecture decisions only," "budget changes")
- Which enforcement tiers are required: `mechanical` (automated, deterministic), `agent_review` (automated, non-deterministic), `human_gate` (steward approval)
- Who can approve at the human gate tier

Gates are composable. A domain might require mechanical checks on all work items, agent review on stories, and human gates only on architecture decisions and budget changes.

---

## 6. Cross-domain work

Initiatives and epics can span multiple domains. When they do:

- Each domain receives its own domain-scoped epic or story
- Work items carry the full list of domains they belong to
- Each domain's steward controls their own gates independently
- Cost is attributed to the domain where the work is performed, not where it was initiated

---

## 7. Domain maturity (non-normative)

Domains evolve in capability over time. Meridian does not prescribe maturity levels but recognizes a natural progression:

- Early domains have context and human gates on everything
- Maturing domains add mechanical constraints and reduce human gate scope
- Advanced domains have full feedback loops, agent-driven work creation, and human gates only on strategic decisions

Implementations may formalize maturity levels and track progression as a metric. This section is non-normative: no Meridian primitive depends on a maturity-level field, and adopters may ignore the framing entirely.

---

*Draft document. Comments welcome via pull request.*
