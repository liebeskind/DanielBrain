# DanielBrain — Context Graph Vision

## Core Thesis

DanielBrain is a shared memory layer for AI agents. It's the foundational substrate of an intelligent operating system where agents are stateless workers that read from and write to a persistent context graph. Any authorized agent — Claude, GPT, custom automation — plugs in via MCP.

## Evolution Path

1. **Personal prototype** (now) — Single user, Slack + Telegram + MCP ingestion, entity graph
2. **Company-wide context graph** — Multi-user, source-determined visibility, shared entity layer
3. **Agent automation platform** — Agents that act on the graph: meeting prep, action tracking, routing

## Data Model: Hybrid Shared/Private

### Shared Layer (Entities)
Entities (people, companies, projects, products) are global canonical nodes. When Alice mentions "Project X" in Slack and Bob mentions it in a meeting transcript, they resolve to the same entity. The entity accumulates context from everyone.

### Private Layer (Thoughts)
Raw thoughts belong to individuals with visibility controls. Each person sees the shared entity graph but only the thoughts they have access to. Entity profiles re-generate scoped to the viewer's access level.

### Selective Sharing
Thoughts can be promoted from private to team/company visibility at any time.

### Source-Determined Default Visibility
- Public Slack channel → `['company']`
- Private Slack channel → `['channel:C12345']` (channel members)
- Slack DM → `['user:U123', 'user:U456']`
- Telegram (personal) → `['owner']`
- MCP save_thought → `['owner']` (default, overridable)
- Call transcripts → `['owner']` (promoted manually or by policy)
- Email → `['owner']` or participants depending on config

### Slack Bot Selective Capture
Users can @mention the bot in Slack to interactively select which parts of a conversation to add to the shared context graph. This gives humans control over what enters the company knowledge base — not everything said in a channel should become permanent context.

## Agent Types

### Ingestion Agents (Capture)
Capture context from new sources — call transcripts, email threads, document changes, calendar events. Primarily writers to the graph.

### Conversational Agents (Read)
Claude Code, ChatGPT, custom chatbots that need context about you, your work, your relationships. They read the graph before responding.

### Automation Agents (Read + Write + Act)
The real power. Agents that act on your behalf — prepare meeting briefs, track commitments, triage messages, draft responses, route information. They read AND write to the graph.

## First Automation Workflow: Meeting Prep Autopilot

Before every meeting, an agent:
1. Reads calendar event (attendees, topic)
2. Resolves attendees to entities
3. Assembles context: recent interactions, open action items, shared projects
4. Computes "what's new since last meeting" temporal diff
5. Delivers briefing to Slack/email automatically

This exercises the full stack: entity resolution, context assembly, temporal reasoning, proactive delivery.

## Architectural Gaps to Address

See `use-cases-by-department.md` for the full gap analysis. Key ones:

1. **Temporal diff** — "What changed since last time?" / "What's new this week?"
2. **Staleness monitoring** — entities and relationships that have gone quiet
3. **Graph traversal** — multi-hop queries ("who knows someone at Company X?")
4. **Write-back** — agents creating/updating entities, closing action items
5. **Action item lifecycle** — open/closed/stale tracking with assignee entities
6. **Entity trending** — mention velocity over time, not just cumulative count
7. **Event/trigger system** — agents react to graph changes, not just poll
8. **Entity-to-entity relationships** — schema exists, populator logic needed
9. **Scoped profile generation** — entity profiles filtered by viewer's access level
10. **Selective Slack capture** — @bot to choose what enters the shared graph
