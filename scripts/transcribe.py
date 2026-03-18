#!/usr/bin/env python3
"""
Transcribe an audio file using faster-whisper (GPU).
Outputs JSON to stdout: { text, segments, language, duration }
Usage: python3 scripts/transcribe.py <audio_path> [model_name]
"""

import json
import sys
import os

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: transcribe.py <audio_path> [model_name]"}), file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "large-v3"

    if not os.path.exists(audio_path):
        print(json.dumps({"error": f"File not found: {audio_path}"}), file=sys.stderr)
        sys.exit(1)

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({"error": "faster-whisper not installed. Run: pip install faster-whisper"}), file=sys.stderr)
        sys.exit(1)

    # Use CUDA if available, else CPU
    device = "cuda"
    compute_type = "float16"
    try:
        import ctranslate2
        if not ctranslate2.get_cuda_device_count():
            device = "cpu"
            compute_type = "int8"
    except Exception:
        pass

    try:
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
        segments_iter, info = model.transcribe(audio_path, beam_size=5)

        segments = []
        full_text_parts = []
        for segment in segments_iter:
            segments.append({
                "start": round(segment.start, 2),
                "end": round(segment.end, 2),
                "text": segment.text.strip(),
            })
            full_text_parts.append(segment.text.strip())

        result = {
            "text": " ".join(full_text_parts),
            "segments": segments,
            "language": info.language,
            "language_probability": round(info.language_probability, 3),
            "duration": round(info.duration, 2),
        }

        print(json.dumps(result))

    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
