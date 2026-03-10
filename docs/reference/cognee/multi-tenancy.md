# Multi-Tenancy: Users, Permissions & Sessions

Baseline: `c9370a8b` (2026-03-08)

## Overview

**Directory:** `cognee/modules/users/`

Cognee supports multi-tenant operation with per-user data isolation. This is relevant to TopiaBrain's upcoming permissions work (Phase 7) and chat feature.

## JWT Authentication

- **Token contents:** user_id, tenant_id, roles
- **Expiry:** 1 hour
- **Endpoints:** `/api/v1/auth/login`, `/api/v1/auth/register`
- Configurable JWT secret via environment variable
- Cookie-based auth as alternative for browser access

## ContextVar-Based Database Isolation

Python's `contextvars.ContextVar` is used to scope database operations per-request:

```python
# Conceptual flow
current_user = ContextVar("current_user")
current_dataset = ContextVar("current_dataset")

# Set at request start (middleware)
current_user.set(authenticated_user)

# All DB operations read from ContextVar
# Queries automatically scoped to current user/dataset
```

This ensures that:
- Each request operates on the correct user's data
- No cross-tenant data leakage
- Pipeline operations (which run async) maintain correct user context
- The `run_pipeline_per_dataset()` function sets these before processing

## Dataset-Level Scoping

All operations are scoped to datasets:
- Data ingestion assigns to a dataset
- `cognify()` processes one dataset at a time
- Search can target specific datasets
- Delete operates at dataset granularity

Datasets provide the primary organizational unit for data isolation.

## Access Control

`backend_access_control_enabled()` — a feature flag that enables/disables access control:

- When enabled: all queries include user/tenant filters
- When disabled: all data visible to all users
- Allows gradual rollout of multi-tenancy features

## SessionManager

Cache-backed conversation history for multi-turn interactions:

### Hierarchy
```
user_id
  └── session_id
        └── qa_id
              ├── question
              └── answer
```

### Purpose
- Maintains conversation state across requests
- Enables context-aware follow-up queries
- Used by the chat/search API for multi-turn conversations
- Cache-backed for performance (not persisted to DB by default)

### Session Identification
- `user_id` — the authenticated user
- `session_id` — a conversation session (one per chat window/context)
- `qa_id` — individual question-answer pair within a session

## Role-Based Permissions

Cognee supports role-based access:
- Users belong to tenants
- Users have roles within tenants
- Permissions checked at the API layer
- Dataset-level permissions for fine-grained access

## Contrast with TopiaBrain

| Aspect | Cognee | TopiaBrain |
|--------|--------|------------|
| Auth | JWT with user_id + tenant_id + roles | API key (64-char hex, single user) |
| Data isolation | ContextVar per request | None (single user) |
| Scoping | Dataset-level | Source-determined visibility (planned) |
| Session management | SessionManager with cache | None (MCP is stateless) |
| Access control | Feature-flagged, role-based | Not implemented (Phase 7) |
| Multi-user | Full multi-tenant | Single user, multi-user planned |

### What's Worth Adopting

**SessionManager pattern** — Directly useful for the upcoming chat feature. We need:
- Per-user conversation history
- Session identification (which chat thread)
- Q&A pair tracking for context

Implementation could be simpler than cognee's — a PostgreSQL table rather than cache-backed, since we're already database-centric.

**ContextVar-like request scoping** — When we implement permissions (Phase 7), we'll need per-request user context. In Express/Node.js, the equivalent is `AsyncLocalStorage`:

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';
const userContext = new AsyncLocalStorage<{ userId: string }>();
```

**Dataset-level scoping concept** — Maps to our visibility model. Instead of datasets, we scope by:
- Source channel (Slack channel, Telegram chat)
- Thought type (meeting, manual, etc.)
- Explicit visibility tags (private, team, company)

### What to Skip

**JWT auth** — Overkill for initial chat feature. API key per user is simpler. JWT becomes relevant if we support browser-based auth.

**Role-based permissions** — Our planned model (Phase 7) is simpler: visibility scoping (private/shared) + API key scopes. Full RBAC isn't needed at our scale.

**Cache-backed sessions** — PostgreSQL is fine for session storage. We don't need the complexity of a separate cache layer.
