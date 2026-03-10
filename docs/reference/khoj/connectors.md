# Khoj Connectors & Content Sources

## Supported Data Sources

| Source | Processor Class | Content Types | Notes |
|--------|----------------|---------------|-------|
| Markdown files | `MarkdownToEntries` | `.md` | Primary format, heading-based chunking |
| PDF files | `PdfToEntries` | `.pdf` | Text extraction from PDFs |
| Org-mode files | `OrgToEntries` | `.org` | Emacs org-mode format |
| Word documents | `DocxToEntries` | `.docx` | Microsoft Word format |
| Plain text | `PlaintextToEntries` | `.txt` | Generic text files |
| Notion pages | `NotionToEntries` | API | Notion integration via API |
| GitHub repos | `GithubToEntries` | API | Issues, commits, Markdown/Org files (deprecated) |
| Images | Image processor | `.jpg`, `.png`, etc. | Image content understanding |

## TextToEntries Base Class

All content processors inherit from `TextToEntries` (`src/khoj/processor/content/text_to_entries.py`), which provides:

- Common entry creation logic
- Embedding generation pipeline
- Database persistence (Entry model)
- FileObject tracking (raw file content)
- Incremental update detection (only re-process changed files)
- Date extraction from content

### Processing Flow

```
Raw File Content
    │
    ▼
Type-Specific Parser (subclass implementation)
    │ Parse document structure, extract text sections
    ▼
Entry Objects (list of text chunks with metadata)
    │
    ▼
split_entries_by_max_tokens()
    │ Uses RecursiveCharacterTextSplitter for oversized entries
    ▼
Sized Chunks (fit within embedding model token limit)
    │
    ▼
Bi-encoder Embedding (batched)
    │
    ▼
Database Storage
    ├── Entry records (text + embedding + metadata)
    └── FileObject records (raw file content tracking)
```

## Chunking Strategy

### RecursiveCharacterTextSplitter
Khoj uses LangChain's `RecursiveCharacterTextSplitter` for entries that exceed the embedding model's token limit:
- Attempts to split on paragraph boundaries first
- Falls back to sentence boundaries
- Falls back to word boundaries
- Maintains overlap between chunks for context continuity

### Type-Specific Parsing
Each processor has its own initial chunking logic:
- **Markdown**: Splits on headings (h1, h2, h3), preserving document structure
- **Org-mode**: Splits on org headings and sections
- **PDF**: Extracts text per page, then applies general chunking
- **Notion**: Uses page/block structure from Notion API
- **GitHub**: Separate entries for issues, commits, and file content

## File Discovery

### fs_syncer Module
The `fs_syncer` module handles file discovery from local sources:
- Uses glob patterns to find files in configured directories
- Supports explicit file lists
- Uses `magika` library for content type detection (not just file extension)
- Ensures proper handling of various file formats

### Content Type Detection
Khoj uses Google's `magika` library for reliable content type detection, going beyond file extensions to inspect actual file content. This prevents misclassification of files.

## Incremental Indexing

### How It Works
1. On each sync, Khoj compares incoming files against stored `FileObject` records
2. Only new or modified files trigger re-processing and re-embedding
3. Deleted files have their entries removed from the database
4. This makes re-syncing fast even for large document collections

### `update_embeddings()` Method
The central method in `text_search.py` that orchestrates incremental updates:
- Compares incoming entries against existing database entries
- Only generates embeddings for new/modified entries
- Creates `FileObject` records to track raw file content
- Extracts and indexes dates found in entry content
- Operates in batches for memory efficiency

## Notion Integration

- Connects via Notion API (requires Notion integration token)
- Syncs all pages the integration has access to
- Preserves page structure (blocks, headings, lists)
- Re-syncs on demand or on schedule
- Configuration via admin panel

## GitHub Integration

- Indexes issues, commits, and Markdown/Org/Text files
- Configurable per-repository
- Note: Currently listed as not actively maintained, potentially deprecated
- Configuration via admin panel with GitHub token

## File Upload

Users can also directly upload files through:
- Web UI (drag and drop)
- API endpoint (`api_content.py`)
- Obsidian plugin (syncs vault contents)

Uploaded files go through the same TextToEntries pipeline as any other source.

## Key Design Patterns

1. **Base class + subclass**: `TextToEntries` provides the common pipeline; subclasses handle parsing
2. **Content-type detection**: Uses `magika` for reliable format detection beyond file extensions
3. **Incremental updates**: Only re-embed changed content (critical for large collections)
4. **FileObject tracking**: Raw file content stored separately from chunked/embedded entries
5. **Batch embedding**: Entries are embedded in batches for efficiency
6. **Date extraction**: Dates found in content are indexed for temporal queries
