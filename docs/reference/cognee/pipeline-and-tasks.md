# Pipeline & Task System

Baseline: `c9370a8b` (2026-03-08)

## Task Class

**File:** `cognee/modules/pipelines/tasks/task.py`

The `Task` class is a polymorphic wrapper around any callable — functions, coroutines, sync generators, or async generators. It uses introspection to determine the executable type and assigns the appropriate execution method.

### Core Interface

```python
class Task:
    def __init__(self, callable, task_config=None):
        # Introspects callable type, sets execution method
        pass

    async def execute(self, *args):
        # Returns an async generator of results
        pass

    async def run(self, *args):
        # Merges and executes, returns final results
        pass
```

### Execution Methods

| Method | Handles | Behavior |
|--------|---------|----------|
| `execute_function()` | Sync functions | Direct call, yield result |
| `execute_coroutine()` | Async functions | Await and yield result |
| `execute_generator()` | Sync generators | Process in batches, yield items |
| `execute_async_generator()` | Async generators | Process in batches, yield items |

### Batch Processing

Configured via `task_config['batch_size']` and `_next_batch_size`:
- Generators yield items one at a time
- Task collects items into batches
- Next task receives a batch as input
- Enables memory-efficient processing of large datasets

## Three-Level Execution Stack

### Level 1: `run_pipeline()`

**File:** `cognee/modules/pipelines/operations/pipeline.py`

Entry point for pipeline execution. Accepts task list, datasets, user, and config.

```python
async def run_pipeline(
    tasks: list[Task],
    datasets: list[Dataset],
    user: User,
    use_pipeline_cache: bool = True,
    data_per_batch: int = 20,
) -> AsyncGenerator[PipelineRunInfo, None]:
```

Responsibilities:
- Validates task list
- Resolves user authorization
- Yields `PipelineRunInfo` objects (status events for progress tracking)
- Delegates to `run_pipeline_per_dataset()` for each dataset

### Level 2: `run_pipeline_per_dataset()`

Sets up per-dataset context:
- Sets database context variables (user, dataset) for access control
- Checks if pipeline was already run (incremental processing)
- Returns cached results if `use_pipeline_cache=True` and results exist
- Otherwise invokes `run_tasks()`

### Level 3: `run_tasks()`

**File:** `cognee/modules/pipelines/operations/run_tasks.py`

Handles actual task execution:
- Batches data items into chunks of `data_per_batch` (default: 20)
- Creates `asyncio.gather` tasks for each item via `run_tasks_data_item()`
- Each data item flows through the task chain sequentially
- Multiple data items processed in parallel

```
Dataset items: [A, B, C, D, E, ...]
                 │  │  │  │  │
                 ▼  ▼  ▼  ▼  ▼      (parallel via asyncio.gather)
Task chain:    T1→T2→T3  for each item
```

## Incremental Processing

Cognee tracks which datasets have been processed. On subsequent runs:
1. Check if pipeline was already executed for this dataset
2. If cached and `use_pipeline_cache=True`, return cached results
3. Otherwise, skip already-processed items within the dataset

This prevents re-processing unchanged data and enables efficient updates when new data is added to an existing dataset.

## Pipeline Status & Events

The pipeline yields `PipelineRunInfo` objects as it executes:
- Status: started, processing, completed, failed
- Progress information for UI/monitoring
- Used by `cognify_status()` MCP tool to report progress

## Distributed Execution

Cognee supports a distributed execution override via decorator, allowing tasks to be dispatched to remote workers instead of running locally. This is an extension point — the default is local async execution.

## Pipeline Caching

When enabled (`use_pipeline_cache=True`):
- Results are stored per (pipeline, dataset) pair
- Subsequent runs return cached results immediately
- Cache invalidated when dataset content changes

## Example: The Cognify Pipeline

The default `cognify()` pipeline chains these tasks:

```
chunk_text
  → extract_entities (v1 or v2, LLM-powered)
  → filter_edges
  → resolve_ontology
  → integrate_knowledge_graph
  → persist_to_graph_db
  → embed_chunks
  → persist_to_vector_db
```

Each step is a `Task` wrapping a callable. The pipeline is composed declaratively and executed by the three-level stack.

## Relevance to TopiaBrain

**Current state:** TopiaBrain's pipeline (`packages/service/src/processor/pipeline.ts`) is procedural — a linear sequence of function calls (chunk → embed → extract → summarize → resolve entities → generate profile).

**Worth adopting:**
- **Task abstraction** — wrapping pipeline steps in a common interface enables recomposition and testing
- **Batch parallelism** — we process items sequentially; asyncio.gather-style parallelism would improve throughput
- **Incremental processing** — our queue system provides this partially, but dataset-level caching could help with reprocessing
- **Status events** — useful for the upcoming chat feature (show processing progress)

**Not worth adopting:**
- **Three-level nesting** — overkill for our single-database, single-user architecture
- **Distributed execution** — unnecessary for our scale
- **Pipeline caching** — our queue system handles dedup via `source_id`
