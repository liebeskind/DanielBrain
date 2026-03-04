# DanielBrain — Use Cases by Department

## Capability Stack (Layers)

### Layer 1 — Capture & Recall
Raw ingestion from Slack, Telegram, MCP. Semantic search. "What did I say about X?"

### Layer 2 — Entity Intelligence
Entities accumulate context. Profiles auto-generate. Connected entities surface. "Tell me about Alice." "What's the relationship between Alice and Project X?"

### Layer 3 — Proactive Context Assembly
Agents push relevant context at the right time. Meeting prep, context diffs, temporal reasoning. Requires event awareness and "what's changed since" logic.

### Layer 4 — Autonomous Action
Agents act on the graph. Triage, draft, track commitments, route information. Requires write-back, confidence scoring, and audit trails.

---

## Use Cases by Layer

| Use Case | Layer | What it exercises |
|----------|-------|-------------------|
| "Tell me about Alice" | 2 | Entity lookup, profile, linked thoughts |
| "Prep me for my meeting with Alice about Project X" | 3 | Context assembly, temporal diff, action items |
| "What changed in my world this week?" | 3 | Context diff, entity activity, new connections |
| "Who should be in the room for the API redesign discussion?" | 3-4 | Graph traversal, relationship inference |
| "Draft a follow-up email to Bob summarizing our last 3 conversations" | 4 | Timeline, content synthesis, write action |
| "Track this action item and remind Alice in 3 days" | 4 | Write-back, scheduling, cross-agent coordination |
| "Route this customer issue to whoever has the most context" | 4 | Entity overlap scoring, team-level graph |

---

## Use Cases by Department

### Sales

| Use Case | What it exercises |
|----------|-------------------|
| "Full context on Acme Corp before my call" | Company entity → linked thoughts, people, products discussed, open action items from all sources |
| "Which deals have gone quiet?" | Company entity staleness monitoring — no new thoughts in X days |
| "Who at our company has a relationship with this prospect?" | Graph traversal: Company → co-mentioned people → filter by internal team |
| "What does this prospect care about?" | Topic entities linked to company, ranked by frequency |
| "Competitive intel on CompetitorCo" | Company entity profile + all linked thoughts across the org |

### Product

| Use Case | What it exercises |
|----------|-------------------|
| "What are users saying about Feature Y?" | Product entity → linked thoughts, sentiment analysis, source breakdown |
| "Who are the stakeholders for Project Z?" | Person entities co-mentioned with project, ranked by mention count |
| "History of decisions on the API redesign" | Project entity timeline, filtered to thought_type = 'decision' |
| "What feature requests keep coming up?" | Topic/product entity trending across sources |
| "Action items from the last 5 product meetings" | get_context with project + thought_type filter |

### CEO / Leadership

| Use Case | What it exercises |
|----------|-------------------|
| "Company pulse this week" | Context diff — new entities, new connections, trending topics, volume by source |
| "Status of our top 5 initiatives" | Project entities sorted by recent activity, with action item summaries |
| "Prepare me for board meeting" | Multi-entity context assembly across all key projects + key people |
| "Biggest open commitments across the org" | Action items aggregated across all thoughts, linked to assignee entities |
| "Who are the key contacts at our top accounts?" | Company → Person graph traversal with relationship edges |

### Marketing

| Use Case | What it exercises |
|----------|-------------------|
| "What topics are customers talking about most?" | Topic entity trending, filtered by source = customer-facing channels |
| "Context for the Acme case study" | Company entity full timeline + related people and products |
| "Key themes from last quarter" | Temporal topic analysis — entity mention_count deltas over time |
| "What language do customers use about our product?" | Raw thought search linked to product entities — real voice of customer |

### Customer Success

| Use Case | What it exercises |
|----------|-------------------|
| "This customer just opened a ticket — give me their full history" | Company entity deep dive: timeline, people involved, all promises/action items |
| "Which accounts haven't had a touchpoint in 30 days?" | Company entity staleness — last_seen_at monitoring |
| "What promises have we made to this account?" | Action items linked to company entity across all sources |
| "Warm handoff brief for this account" | Context assembly: company + all people + recent activity |

### Engineering

| Use Case | What it exercises |
|----------|-------------------|
| "Who has the most context on the payments system?" | Person entities ranked by mention_count co-occurring with project/topic |
| "What was decided in the last architecture review?" | Project timeline filtered by thought_type + date |
| "Onboard this new hire — what should they know about their team's work?" | Person → team → project graph traversal, recent activity summary |

### HR / People Ops

| Use Case | What it exercises |
|----------|-------------------|
| "Candidate interview journey" | Person entity timeline, filtered to hiring-related sources |
| "Who's been collaborating across teams?" | Graph analysis: people co-mentioned across different project entities |
| "Engagement signals" | Person entity activity patterns — who's active, who's gone quiet |

---

## Key Insight

Every department needs the same underlying capabilities — entity lookup, context assembly, timeline, action item tracking — just scoped differently. The MCP API surface we've built (get_entity, list_entities, get_context, get_timeline) already covers the foundational queries. The gaps are:

1. **Temporal diff** — "What changed since X?" (Layer 3)
2. **Staleness monitoring** — "What's gone quiet?" (Layer 3)
3. **Graph traversal** — "Who knows someone at Company X?" (Layer 3-4)
4. **Write-back** — Agents creating/updating entities and thoughts (Layer 4)
5. **Action item lifecycle** — Track open/closed/stale across all sources (Layer 3-4)
6. **Entity trending** — Mention velocity, not just count (Layer 3)
