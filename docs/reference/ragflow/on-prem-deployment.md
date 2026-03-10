# RAGFlow On-Prem Deployment

## Overview

RAGFlow is designed for self-hosting via Docker Compose. It officially supports x86 CPU and NVIDIA GPU deployments. ARM64 is tested but not officially maintained.

## Docker Deployment

### Images

- **Full image** (~9 GB): includes DeepDoc vision models + built-in BGE/BCE embedding and reranking models
- **Slim image** (~1 GB): includes DeepDoc vision models only — requires external model services for embeddings and reranking

### Compose Profiles

Docker Compose uses profiles to select the document engine:
- `elasticsearch` profile (default)
- `infinity` profile
- `opensearch` profile

Only one profile is active at a time.

### System Requirements

- `vm.max_map_count=262144` — required for Elasticsearch (set via `sysctl`)
- Sufficient RAM for the document engine (Elasticsearch is memory-hungry)
- Docker and Docker Compose

## GPU Requirements

### Without Local LLM Inference

When using external LLM services (cloud APIs or remote Ollama/vLLM):
- **No GPU required for the RAGFlow server itself**
- DeepDoc vision models (OCR, layout, TSR) run on CPU via ONNX
- Built-in embedding/reranking models can run on CPU (slower) or GPU

### With Local LLM Inference

When running chat models locally:
- GPU requirements depend on model size (e.g., Qwen2-7B needs ~16 GB VRAM)
- Separate from RAGFlow's own compute — models run in Ollama/vLLM/Xinference

### VLM-HTTP-Client Backend

A newer deployment pattern: RAGFlow server has no GPU, connects to a remote vLLM server over HTTP. Enables cost-effective distributed deployment with multiple RAGFlow instances sharing one GPU server.

## Local Model Integration

RAGFlow supports deploying local models via:

| Framework | Use Case |
|-----------|----------|
| **Ollama** | Chat models + embedding models (must be on same LAN or configure `OLLAMA_HOST=0.0.0.0`) |
| **vLLM** | High-performance inference for chat models |
| **Xinference** | Multi-model serving |
| **SGLang** | Efficient LLM inference |
| **GPUStack** | Multi-GPU model serving |

### Ollama Integration

- Ollama and RAGFlow must be on the same LAN
- Configure `OLLAMA_HOST=0.0.0.0` for remote access
- RAGFlow can use Ollama for both chat (e.g., llama3.1, qwen2) and embeddings (e.g., nomic-embed-text, bge-m3)

## Viability for DGX Spark

RAGFlow is fully viable on the DGX Spark:

| Component | DGX Spark Fit |
|-----------|--------------|
| RAGFlow server | Yes — runs on CPU, Docker-based |
| DeepDoc (OCR/layout/TSR) | Yes — ONNX models run on CPU |
| Elasticsearch/Infinity | Yes — runs in Docker |
| Ollama (embeddings + chat) | Yes — already running on DGX Spark |
| GPU for inference | Yes — DGX Spark has NVIDIA GPU |

**Key consideration**: RAGFlow adds Elasticsearch (or Infinity) as a required service alongside PostgreSQL. This increases memory and storage requirements compared to TopiaBrain's PostgreSQL-only architecture.

## Data Sovereignty

RAGFlow supports fully on-prem operation:
- All document processing happens locally (DeepDoc, chunking, embedding)
- Chat models can be local (Ollama/vLLM)
- No mandatory external API calls
- Compatible with TopiaBrain's data sovereignty constraint

The one exception: if configured to use cloud LLM APIs (OpenAI, etc.) for chat or embeddings, data would leave the premises. This is opt-in and not required.
