# Claude Pilot — Product Direction

> Development cockpit for Claude Code.

This document is the single source of truth for Claude Pilot's product direction.
It is intentionally opinionated and short. If a feature request doesn't align with
the principles and anti-goals below, the default answer is "no".

---

## 1. Vision

**Development cockpit for Claude Code** — a focused companion UI that lives
alongside cmux and Claude Code, addressing pains that Claude Code alone cannot.

Claude Pilot is **not** a replacement for Claude Code. It is a purpose-built
cockpit for a specific kind of user, with a specific set of pains.

---

## 2. Target Persona

Claude Pilot is for users who meet **all** of the following:

- Use Claude Code as a primary development tool (daily driver)
- Use cmux as the terminal multiplexer (desktop, not mobile)
- Experience one or more of the pains listed in §3
- Are willing to trade up-front learning for long-term leverage

**Primary personas:**
- **P1** Solo developer running Claude Code intensively on a single project
- **P2** Power user of cmux who orchestrates multiple panes and tools
- **P3** Developer running **multiple Claude Code / AI agents in parallel**
  across several projects

**Who this is NOT for:**
- Users who are happy with Claude Code alone — they should keep using Claude
  Code directly. Claude Pilot exists to solve specific pains, not to be a
  universal wrapper.

---

## 3. Core Pains We Solve

All of these are real, and they compound. Claude Pilot addresses them as a
coherent system, not as a feature catalog:

| # | Pain | Root cause |
|---|------|-----------|
| 1 | Session context evaporates — "where was I?" | Claude Code session boundaries, no persistent phase state |
| 2 | Decision paralysis — too many skills/commands to pick from | Flat catalog of tools, no context-aware filtering |
| 3 | Rework recovery is painful | No explicit phase model, no way to "go back and re-plan" |
| 4 | Parallel project management is cognitively heavy | Terminal-centric workflow doesn't scale across projects |
| 5 | Skill/command sprawl | Users can't remember what they have or when to use it |
| 6 | Retrospective cycle doesn't happen | No built-in mechanism to reflect on completed work |

---

## 4. Design Principles

These are the rules Claude Pilot uses to decide between competing options.

### P1. Simplicity through UI segregation, not feature removal
> The problem isn't that we have too many features. The problem is showing
> them all at once.

Keep the necessary features. Separate them across UI contexts (panels, modes,
panes) so that any single screen stays simple. **Don't** solve complexity by
deleting features the target users need.

### P2. Pain-driven, not feature-driven
Every feature must trace back to a pain in §3. If a feature exists because
"it would be cool" or "other tools have it", that's a sign to cut it.

### P3. Opinionated over universal
Claude Pilot makes decisions for the user. Decision tree navigation picks a
path. Autopilot runs substeps in order. The user can override, but the default
is always a confident suggestion.

### P4. Desktop + cmux is the baseline
Claude Pilot assumes cmux + desktop terminal. We do not optimize for:
- Mobile
- Browser-only use (no terminal)
- Non-cmux terminal multiplexers

If a design decision makes cmux-integrated use worse, that's a blocker.

### P5. Autopilot-first, human-in-the-loop for judgment
The happy path is Claude Pilot running autonomously (Autopilot). Humans
intervene only when judgment is required — and the UI surfaces that moment
explicitly via the decision tree / next-action prompts.

### P6. Behavioral-psychology-aware UX
"Too many choices → no choice." "Losses hurt 2x gains." Design follows these
truths. Recommendations are ranked. Actions are framed positively. Undo is
first-class.

---

## 5. UX Pillars

Each pillar maps to one or more pains. New features belong to exactly one
pillar as their primary purpose.

| Pillar | What it means | Maps to pain |
|--------|--------------|-------------|
| **Visibility** | Always know where you are in the workflow | #1 |
| **Guidance** | Always know what to do next, without scanning a catalog | #2, #5 |
| **Resilience** | Always be able to go back, retry, or re-plan | #3 |
| **Parallel** | Handle multiple projects/sessions without context loss | #4 |
| **Curation** | Right tool surfaces at the right time | #2, #5 |
| **Learning** | Reflection and improvement are built into the loop | #6 |

---

## 6. Anti-goals

Claude Pilot will **not**:

1. **Replace Claude Code.** We are a companion, not a competitor.
2. **Become a generic project management tool.** We are not Jira / Linear /
   Notion. PRDs are for feeding into AI workflows, not for status reporting.
3. **Add enterprise lock-in features** (SAML, audit logs, role-based access,
   SSO integrations) beyond what individual developers need.
4. **Ship mobile UI.** Desktop only.
5. **Optimize for users who don't have the pains in §3.** If someone is happy
   with Claude Code alone, we don't need to convert them.
6. **Deviate from the cmux + desktop premise.** Features that assume
   browser-only or standalone use are out of scope.
7. **Add features for monetization.** We are OSS-first.

---

## 7. Success Signals

### North Star
- **S2 · Autopilot completion rate** — percentage of Autopilot runs that
  finish end-to-end without manual intervention.

  *Why this is the North Star:* Principle P5 ("Autopilot-first, human in the
  loop for judgment") is the core of the product. If Autopilot fails,
  nothing else matters — the happy path is broken. If Autopilot succeeds,
  it means the workflow, gate model, skill curation, and cmux integration
  are all healthy together.

### Supporting signals
These are secondary but still watched. A drop in any of them without a
corresponding gain elsewhere is a warning sign.

- **S1** Daily invocation — users launch Claude Pilot as part of their
  everyday Claude Code workflow (DAU / active projects)
- **S3** Recovery count — times users successfully used the decision tree /
  Explore mode to get unstuck
- **S4** Manual navigation reduction — fewer clicks to pick the next action
  (cognitive load proxy)
- **S5** Parallel project throughput — users routinely run Claude Pilot on
  2+ projects simultaneously

The North Star is the primary signal we optimize for. Supporting signals
prevent us from gaming the North Star at the cost of overall health.

---

## 8. How to use this document

- **For feature decisions**: Does it trace to a pain (§3)? Does it violate any
  principle (§4) or anti-goal (§6)? Which pillar (§5) does it primarily serve?
- **For user story generation**: Stories are generated against this document.
  Every story must specify its pain, pillar, and persona.
- **For disagreements**: This document wins. If we realize it's wrong, we
  update it explicitly — we don't route around it.

---

*Last updated: 2026-04-08. Owned by the maintainer. Changes require intent,
not drift.*
