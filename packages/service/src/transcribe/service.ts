import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { updateJob, getJob } from './job-tracker.js';
import type { Config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'scripts');

export async function runTranscription(jobId: string, config: Config): Promise<void> {
  const job = getJob(jobId);
  if (!job) return;

  updateJob(jobId, { status: 'transcribing' });

  try {
    // Run Python transcription script
    const transcriptResult = await runPythonTranscribe(job.audioPath, config.whisperModel);

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

interface PythonTranscribeResult {
  text: string;
  segments: Array<{ start: number; end: number; text: string }>;
  language: string;
  duration: number;
}

export function runPythonTranscribe(audioPath: string, model: string): Promise<PythonTranscribeResult> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(SCRIPTS_DIR, 'transcribe.py');

    execFile(
      'python3',
      [scriptPath, audioPath, model],
      {
        timeout: 600_000, // 10 minutes
        maxBuffer: 50 * 1024 * 1024, // 50MB for large transcripts
      },
      (error, stdout, stderr) => {
        if (error) {
          // Try to extract error JSON from stderr
          let errorMsg = error.message;
          if (stderr) {
            try {
              const parsed = JSON.parse(stderr);
              if (parsed.error) errorMsg = parsed.error;
            } catch {
              errorMsg = stderr.trim() || errorMsg;
            }
          }
          reject(new Error(errorMsg));
          return;
        }

        try {
          const result = JSON.parse(stdout);
          resolve(result);
        } catch {
          reject(new Error('Failed to parse transcription output'));
        }
      },
    );
  });
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

export function formatAsSrt(segments: Array<{ start: number; end: number; text: string }>): string {
  return segments.map((seg, i) => {
    const startTime = formatSrtTime(seg.start);
    const endTime = formatSrtTime(seg.end);
    return `${i + 1}\n${startTime} --> ${endTime}\n${seg.text}\n`;
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
