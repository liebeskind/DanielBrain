# Khoj On-Prem Viability

## Self-Hosting Setup

### Docker (Recommended)
```bash
mkdir khoj && cd khoj
# Download docker-compose.yml
docker compose up -d
```

The Docker Compose setup provides all 5 services:
1. **Server** -- Khoj application (Django + Gunicorn)
2. **Database** -- PostgreSQL + pgvector
3. **Sandbox** -- Terrarium (Python code execution)
4. **Search** -- SearxNG (web search)
5. **Computer** -- VNC desktop (optional)

### Pip (Advanced)
Requires manual setup of:
- PostgreSQL with pgvector extension
- Python 3.10+
- `pip install khoj` (installs the package from PyPI)

### Minimum Requirements
- **RAM:** 8 GB minimum, 16 GB recommended
- **VRAM:** 16 GB recommended (for local LLM + embedding models)
- **Disk:** Depends on document corpus size + PostgreSQL storage
- **CPU:** Modern multi-core (embedding model runs on CPU if no GPU)

## Ollama Integration

Khoj integrates with Ollama as an OpenAI-compatible API provider.

### Configuration Steps
1. Install and start Ollama on the host machine
2. Pull desired models (e.g., `ollama pull llama3.1:8b`)
3. In Khoj admin panel, create an OpenAI API config:
   - **API URL:** `http://localhost:11434/v1/` (or `http://host.docker.internal:11434/v1/` for Docker)
   - **API Key:** Leave blank or set dummy value
4. Add a Chat Model pointing to the Ollama model name
5. Restart Khoj server

### Docker Network Note
When running Khoj in Docker and Ollama on the host:
- Use `http://host.docker.internal:11434/v1/` as the API URL
- Or configure Docker networking to allow container-to-host communication

## Fully Offline Operation

Khoj CAN work completely offline with local models:

### What Works Offline
- **Chat**: Via Ollama or any local LLM server (llama-cpp-server, vLLM, LMStudio)
- **Search**: Bi-encoder and cross-encoder models run locally via sentence-transformers
- **Document indexing**: Embedding generation is local
- **Code execution**: Terrarium sandbox is self-hosted

### What Requires Internet
- **Online search**: SearxNG needs internet (but this tool can be disabled per agent)
- **Cloud LLM providers**: OpenAI/Anthropic/Google (not needed if using Ollama)
- **Notion sync**: Requires Notion API access
- **GitHub sync**: Requires GitHub API access

### Fully Air-Gapped Setup
For a completely air-gapped deployment:
1. Use Ollama with pre-downloaded models
2. Disable online search tool on agents
3. Upload files directly (no Notion/GitHub sync)
4. Use local file sync for document ingestion
5. Result: Fully functional chat + search with zero internet dependency

## Supported LLM Providers

| Provider | Type | Models | Setup |
|----------|------|--------|-------|
| Ollama | Local | llama3, qwen, gemma, mistral, deepseek, etc. | OpenAI-compatible API |
| llama-cpp-server | Local | Any GGUF model | OpenAI-compatible API |
| vLLM | Local | Any HuggingFace model | OpenAI-compatible API |
| LMStudio | Local | Any supported model | OpenAI-compatible API |
| LiteLLM | Proxy | Any (proxies to various providers) | OpenAI-compatible API |
| OpenAI | Cloud | GPT-4o, GPT-4.1, o1, o3 | API key |
| Anthropic | Cloud | Claude 3.5, Claude 4 | API key |
| Google | Cloud | Gemini 1.5, Gemini 2.0 | API key |

All local providers use the same OpenAI-compatible API interface, making them interchangeable.

## Embedding Models

### Local (Default)
- `paraphrase-multilingual-MiniLM-L12-v2` -- default bi-encoder
- Runs on CPU via sentence-transformers library
- No GPU required (but GPU accelerates indexing)
- Supports 50+ languages

### Remote (Optional)
- OpenAI embeddings API
- Azure OpenAI embeddings
- Any OpenAI-compatible embedding API

### Cross-Encoder (Local)
- Loaded via sentence-transformers
- Runs on CPU
- Used only at query time for reranking (not at index time)

## Resource Usage Comparison

### Minimal Setup (CPU only, Ollama)
- Khoj server: ~500 MB RAM
- PostgreSQL: ~200 MB RAM
- Ollama (7B model): ~4-8 GB RAM
- Embedding models: ~500 MB RAM
- Total: ~6-10 GB RAM

### Full Setup (GPU, all services)
- Khoj server: ~500 MB RAM
- PostgreSQL: ~500 MB RAM
- Ollama (70B model): ~40 GB VRAM
- Embedding models: ~1 GB RAM
- Terrarium sandbox: ~200 MB RAM
- SearxNG: ~200 MB RAM
- Total: ~3 GB RAM + GPU VRAM for LLM

## Production Deployment

### Two Docker Images
- **Self-hosted image** (`ghcr.io/khoj-ai/khoj:latest`): Development/personal use
- **Cloud image** (`ghcr.io/khoj-ai/khoj-cloud:latest`): Multi-user cloud deployment

### Security Considerations
- Django admin panel is password-protected
- API authentication via user sessions or API keys
- Terrarium sandbox isolates code execution
- SearxNG is self-hosted (no external search API keys leaked)
- Data stays within your network

## Key Takeaways for On-Prem

1. **Fully viable**: Khoj is designed for self-hosting with local models
2. **One command**: Docker Compose setup is genuinely simple
3. **No cloud dependency**: Everything can run locally with Ollama
4. **Moderate resources**: 8-16 GB RAM for basic setup; GPU helps but not required
5. **OpenAI-compatible API**: Any local LLM server works, not locked to Ollama
6. **Embedding models are local**: Search works without any API calls
7. **SearxNG for web search**: Self-hosted search, no API keys needed
