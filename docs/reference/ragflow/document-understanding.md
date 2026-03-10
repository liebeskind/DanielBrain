# RAGFlow Document Understanding — DeepDoc

## Overview

DeepDoc is RAGFlow's document understanding engine. It has two parts: **vision** (computer vision models for understanding document layout) and **parser** (format-specific text extraction). This is RAGFlow's key differentiator — most RAG systems treat documents as flat text; DeepDoc understands spatial structure.

## Vision Pipeline

### OCR (Optical Character Recognition)

- Built on **PaddleOCR**, converted to **ONNX** format for portable inference
- Handles typed, handwritten, and printed text
- Works on scanned PDFs, images, and embedded figures
- Auto-detects rotation angle using OCR confidence scores (critical for scanned tables)

### Layout Recognition (DLR — Document Layout Recognition)

- Uses **YOLOv10** (object detection), trained on document layout labels
- ONNX format for inference
- Architecture: lightweight backbone (YOLOv8-inspired) -> multi-scale feature neck -> anchor-free decoupled head
- Identifies document regions: headers, paragraphs, tables, figures, captions, lists, page numbers, footers
- **Why it matters**: layout analysis determines whether text blocks are successive (should be merged), whether a region needs table structure recognition, or whether it is a figure with a caption

### Table Structure Recognition (TSR)

- Also uses **YOLOv10**, trained on table structure labels
- Handles complex tables: hierarchical headers, spanning cells, projected row headers
- Output: table content translated into natural language sentences (not just raw cell values)
- This is critical — naive table extraction loses relational meaning; TSR preserves it

## PDF Parser Output

The PDF parser produces three types of output:
1. **Text chunks** — with position metadata (page number, rectangular coordinates in PDF)
2. **Tables** — cropped image from PDF + content translated to natural language
3. **Figures** — with extracted caption and any text within the figure

## PDF Parser Options

RAGFlow offers multiple PDF parsers, selectable per knowledge base:

| Parser | Description | Best For |
|--------|-------------|----------|
| **DeepDoc** (default) | Full vision pipeline: OCR + layout + TSR | Scanned docs, complex layouts, tables |
| **Naive** | Skips OCR/TSR/DLR, plain text extraction only | Clean text-only PDFs (fast) |
| **MinerU** | Open-source PDF converter (experimental) | Mathematical formulas, intricate layouts |
| **Docling** | Open-source doc processing tool (experimental) | Alternative to DeepDoc |

Since v0.17.0, RAGFlow decouples the parser (data extraction) from chunking. You pick a parser for extraction, then independently choose a chunking strategy.

## Supported File Formats (23+)

| Category | Formats |
|----------|---------|
| Documents | PDF, DOC, DOCX, TXT, MD, MDX, HTML |
| Spreadsheets | CSV, XLSX, XLS (output as HTML preserving row/column structure) |
| Presentations | PPT, PPTX |
| Images | JPEG, JPG, PNG, TIF, GIF |
| Email | EML |
| Audio | (via transcription in ingestion pipeline) |
| Video | (via transcription in ingestion pipeline) |

## Model Sizes and Resource Impact

- **Slim Docker image** (~1 GB): no built-in embedding/reranking models — uses external model services
- **Full Docker image** (~9 GB): includes built-in BGE/BCE embedding and reranking models
- DeepDoc vision models (OCR, layout, TSR) are always included and run on CPU (ONNX) or GPU

## Key Insight for TopiaBrain

RAGFlow's document understanding is its moat. For TopiaBrain, the relevant pattern is: **before chunking, understand what you are looking at**. Fathom transcripts, Slack threads, and future document uploads could benefit from a lightweight "layout analysis" step that identifies structure (speaker turns, topic boundaries, action item sections) before chunking.
