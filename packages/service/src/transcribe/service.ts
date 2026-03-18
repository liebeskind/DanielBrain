import fs from 'fs';
import { updateJob, getJob } from './job-tracker.js';
import type { Config } from '../config.js';

export async function runTranscription(jobId: string, config: Config): Promise<void> {
  const job = getJob(jobId);
  if (!job) return;

  updateJob(jobId, { status: 'transcribing' });

  try {
    // Transcribe via faster-whisper-server API (OpenAI-compatible)
    const transcriptResult = await callWhisperApi(job.audioPath, config);

    updateJob(jobId, { status: 'summarizing' });

    // Generate summary via Ollama
    let summary: string | undefined;
    try {
      summary = await generateSummary(transcriptResult.text, config);
    } catch (err) {
      console.warn('Transcription summary failed (non-fatal):', (err as Error).message);
    }

    updateJob(jobId, {
      status: 'completed',
      completedAt: new Date(),
      result: {
        ...transcriptResult,
        summary,
      },
    });
  } catch (err) {
    updateJob(jobId, {
      status: 'failed',
      completedAt: new Date(),
      error: (err as Error).message,
    });
  }
}

interface TranscribeResult {
  text: string;
  segments: Array<{ start: number; end: number; text: string; speaker?: string }>;
  language: string;
  duration: number;
  speakers?: Record<string, { duration: number; segments: number }>;
}

async function callWhisperApi(audioPath: string, config: Config): Promise<TranscribeResult> {
  const fileBuffer = await fs.promises.readFile(audioPath);
  const filename = audioPath.split('/').pop() || 'audio.wav';
  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer]), filename);

  // Try whisperx-blackwell API first (GPU, with diarization)
  try {
    formData.append('language', 'auto');
    const response = await fetch(`${config.whisperBaseUrl}/transcribe`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(600_000),
    });

    if (response.ok) {
      const data = await response.json() as {
        status: string;
        language: string;
        segments: Array<{ start: number; end: number; text: string; speaker?: string }>;
        speakers?: Record<string, { duration: number; segments: number }>;
      };

      if (data.status === 'success' && data.segments) {
        const text = data.segments.map(s => {
          const prefix = s.speaker ? `[${s.speaker}] ` : '';
          return prefix + s.text.trim();
        }).join('\n');

        const lastSeg = data.segments[data.segments.length - 1];
        const duration = lastSeg ? lastSeg.end : 0;

        return {
          text,
          segments: data.segments.map(s => ({
            start: Math.round(s.start * 100) / 100,
            end: Math.round(s.end * 100) / 100,
            text: s.text.trim(),
            speaker: s.speaker,
          })),
          language: data.language || 'unknown',
          duration,
          speakers: data.speakers,
        };
      }
    }
  } catch {
    // Fall through to OpenAI-compatible API
  }

  // Fallback: OpenAI-compatible API (faster-whisper-server on CPU)
  const fallbackForm = new FormData();
  fallbackForm.append('file', new Blob([fileBuffer]), filename);
  fallbackForm.append('model', `Systran/faster-whisper-${config.whisperModel}`);
  fallbackForm.append('response_format', 'verbose_json');
  fallbackForm.append('timestamp_granularities[]', 'segment');

  const response = await fetch(`${config.whisperBaseUrl}/v1/audio/transcriptions`, {
    method: 'POST',
    body: fallbackForm,
    signal: AbortSignal.timeout(600_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Whisper API error: ${response.status} ${errorText}`);
  }

  const data = await response.json() as {
    text: string;
    language: string;
    duration: number;
    segments?: Array<{ start: number; end: number; text: string }>;
  };

  return {
    text: data.text || '',
    segments: (data.segments || []).map(s => ({
      start: Math.round(s.start * 100) / 100,
      end: Math.round(s.end * 100) / 100,
      text: s.text.trim(),
    })),
    language: data.language || 'unknown',
    duration: data.duration || 0,
  };
}

async function generateSummary(text: string, config: Config): Promise<string> {
  // Truncate very long transcripts for summary (keep first ~8000 chars)
  const truncated = text.length > 8000 ? text.slice(0, 8000) + '\n\n[... transcript truncated for summary ...]' : text;

  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.extractionModel,
      messages: [
        {
          role: 'system',
          content: 'You are a concise summarizer. Produce a 2-4 sentence summary of the following transcript. Focus on key topics discussed, decisions made, and action items. Do not start with "This transcript" or "The transcript".',
        },
        {
          role: 'user',
          content: truncated,
        },
      ],
      stream: false,
      options: { temperature: 0.3 },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status}`);
  }

  const data = await response.json() as { message?: { content?: string } };
  return data.message?.content?.trim() || '';
}

export function formatAsSrt(segments: Array<{ start: number; end: number; text: string; speaker?: string }>): string {
  return segments.map((seg, i) => {
    const startTime = formatSrtTime(seg.start);
    const endTime = formatSrtTime(seg.end);
    const prefix = seg.speaker ? `[${seg.speaker}] ` : '';
    return `${i + 1}\n${startTime} --> ${endTime}\n${prefix}${seg.text}\n`;
  }).join('\n');
}

function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad3(ms)}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function pad3(n: number): string {
  return n.toString().padStart(3, '0');
}
