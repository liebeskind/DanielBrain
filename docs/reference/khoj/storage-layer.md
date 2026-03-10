# Khoj Storage Layer

## Database

PostgreSQL with pgvector extension, managed through Django ORM.

## Core Django Models

Located in `src/khoj/database/models.py`:

### KhojUser
Extended Django user model. Represents an authenticated user of the system.
- Standard Django auth fields (username, email, password)
- Used as foreign key throughout the system for multi-user isolation

### Subscription
User subscription/tier information.
- Linked to KhojUser
- Controls access to features and usage limits

### Entry
The central content model. Represents a chunk of indexed content with its embedding.
- **text**: The actual text content of the chunk
- **embeddings**: pgvector `VectorField` -- the bi-encoder embedding vector
- **file_type**: Content type (markdown, pdf, org, notion, github, etc.)
- **file_source**: Which connector provided this content
- **file_path/file_name**: Original source location
- **user**: Foreign key to KhojUser (multi-user isolation)
- **corpus_id**: Groups entries from same indexing source
- **dates_metadata**: Extracted dates from content (for temporal queries)
- **heading**: Section heading (for structured documents)
- **compiled**: Pre-processed text for search

Indexes: HNSW index on embeddings (pgvector), GIN index on text for full-text search, B-tree on file metadata.

### FileObject
Tracks raw file content separate from chunked entries.
- **file_name**: Original filename
- **raw_text**: Complete file content before chunking
- **user**: Foreign key to KhojUser

Purpose: Enables incremental indexing by comparing incoming files against stored originals. Also allows reconstruction of full documents from chunks.

### Conversation
Represents a chat conversation session.
- **user**: Foreign key to KhojUser
- **conversation_log**: JSON field storing the full conversation history
- **agent**: Optional foreign key to Agent (if agent-scoped conversation)
- **client**: Which client application created this conversation
- **title**: Conversation title (auto-generated or user-set)
- **created_at / updated_at**: Timestamps

The conversation_log JSON contains an ordered array of turns, each with:
```json
{
  "message": "user query text",
  "response": "khoj response text",
  "by": "you" | "khoj",
  "intent": {
    "type": "remember" | "general" | ...,
    "inferred-queries": ["reformulated query 1", "query 2"]
  },
  "context": ["reference 1", "reference 2"],
  "onlineContext": { ... },
  "codeContext": { ... },
  "operatorContext": { ... },
  "created": "ISO timestamp"
}
```

### ChatMessageModel
Individual chat messages (may be separate from or linked to Conversation).
- Links to conversation
- Stores message content, sender, timestamps
- Metadata including Intent object

### Agent
Custom AI agent configuration.
- **name**: Agent display name
- **personality**: System prompt / persona text
- **chat_model**: Foreign key to ChatModel (which LLM to use)
- **tools**: Which tools the agent can access
- **knowledge_base**: Dedicated document collection
- **public**: Whether accessible to all server users
- **avatar**: Agent avatar image
- **creator**: Foreign key to KhojUser who created the agent

### ChatModel
LLM configuration.
- **name**: Model name (e.g., "gpt-4o", "llama3.1:8b")
- **model_type**: Provider type (openai, anthropic, google, offline)
- **api_key**: Provider API key (or null for local)
- **api_base_url**: Override URL (for Ollama, vLLM, etc.)
- **max_prompt_size**: Token limit for this model
- **vision_enabled**: Whether the model supports image input
- **tokenizer**: Which tokenizer to use for token counting

### SearchModelConfig
Search model configuration.
- **biencoder**: Bi-encoder model name (default: paraphrase-multilingual-MiniLM-L12-v2)
- **cross_encoder**: Cross-encoder model name
- **embeddings_inference_endpoint**: Remote embedding API URL (optional)
- **embeddings_inference_endpoint_type**: API type (openai, etc.)
- **embeddings_inference_endpoint_api_key**: API key for remote embeddings

### UserMemory
Long-term user memory/preferences.
- Facts and preferences extracted from conversations
- Injected into system prompt for personalization
- Per-user storage

### ClientApplication
Registered client applications (Obsidian, Emacs, web, etc.).

## Database Adapters

`src/khoj/database/adapters.py` provides a data access layer between the Django ORM and the application logic:

- **EntryAdapters**: CRUD for Entry, search, filtering, batch operations
- **ConversationAdapters**: Create/read/update conversations, query history
- **FileObjectAdapters**: File tracking for incremental indexing
- **AgentAdapters**: Agent CRUD and lookup
- **UserAdapters**: User management

This adapter pattern keeps raw ORM queries out of the routers and processors.

## Embedding Storage

- Embeddings stored as pgvector `VectorField` on the `Entry` model
- HNSW index for approximate nearest neighbor search
- Cosine similarity for search scoring
- Embedding dimension determined by the configured bi-encoder model
- No separate vector database -- everything in PostgreSQL

## Conversation Persistence

Conversations are stored as JSON in the `Conversation` model's `conversation_log` field. This is a JSON column (not a separate messages table), meaning:
- The entire conversation history is one JSON document
- Appending a turn means reading the JSON, appending, and writing back
- This is simple but means very long conversations grow the JSON blob
- Trade-off: simplicity over normalized relational storage

Each conversation turn includes:
- User message and Khoj response
- Intent classification
- References/citations used
- Online/code/operator results
- Timestamps
- Generated images/diagrams
- Research iterations (for research mode)

## File Storage

- Raw file content stored in `FileObject` model (in the database, not on disk)
- Used for incremental indexing comparison
- Allows reconstruction of original documents
- No separate file storage system (S3, etc.) -- everything in PostgreSQL

## Key Design Patterns

1. **PostgreSQL for everything**: Embeddings, files, conversations, users -- all in one database
2. **JSON conversation log**: Simple but denormalized approach to conversation storage
3. **Adapter pattern**: Database queries encapsulated in adapter classes
4. **pgvector native**: No separate vector database; leverages PostgreSQL extensions
5. **Per-user isolation**: All content models have a user foreign key
6. **FileObject for dedup**: Raw files tracked separately for incremental indexing
