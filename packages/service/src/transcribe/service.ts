import fs from 'fs';
import { execFile } from 'child_process';
import { updateJob, getJob } from './job-tracker.js';
import type { Config } from '../config.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('transcribe');

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
      log.warn({ err }, 'Transcription summary failed (non-fatal)');
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

function callWhisperApi(audioPath: string, config: Config): Promise<TranscribeResult> {
  // Use curl for reliable large file upload (Node 18 fetch has issues with big multipart bodies)
  return new Promise((resolve, reject) => {
    execFile(
      'curl',
      [
        '-s', '-S',
        '--max-time', '600',
        '-X', 'POST',
        `${config.whisperBaseUrl}/transcribe`,
        '-F', `file=@${audioPath}`,
        '-F', 'language=auto',
      ],
      { maxBuffer: 50 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }

        try {
          const data = JSON.parse(stdout) as {
            status: string;
            detail?: string;
            language: string;
            segments: Array<{ start: number; end: number; text: string; speaker?: string }>;
            speakers?: Record<string, { duration: number; segments: number }>;
          };

          if (data.detail) {
            reject(new Error(`Whisper API error: ${data.detail}`));
            return;
          }

          const text = (data.segments || []).map(s => {
            const prefix = s.speaker ? `[${s.speaker}] ` : '';
            return prefix + s.text.trim();
          }).join('\n');

          const lastSeg = data.segments?.[data.segments.length - 1];
          const duration = lastSeg ? lastSeg.end : 0;

          resolve({
            text,
            segments: (data.segments || []).map(s => ({
              start: Math.round(s.start * 100) / 100,
              end: Math.round(s.end * 100) / 100,
              text: s.text.trim(),
              speaker: s.speaker,
            })),
            language: data.language || 'unknown',
            duration,
            speakers: data.speakers,
          });
        } catch {
          reject(new Error('Failed to parse whisper response'));
        }
      },
    );
  });
}

export async function generateSummary(
  text: string,
  config: Config,
  speakerNames?: Record<string, string>,
): Promise<string> {
  // Truncate very long transcripts (llama3.3:70b has 128K context, use up to ~32K chars)
  const truncated = text.length > 32000 ? text.slice(0, 32000) + '\n\n[... transcript truncated for summary ...]' : text;

  const speakerContext = speakerNames && Object.keys(speakerNames).length > 0
    ? `\n\nSPEAKER IDENTIFICATION:\n${Object.entries(speakerNames).map(([label, name]) => `${label} = ${name}`).join('\n')}\nUse the real names (not speaker labels) throughout your summary.`
    : '';

  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.extractionModel,
      messages: [
        {
          role: 'system',
          content: `You are a meeting analyst. Produce a detailed, structured summary of the following transcript.

FORMAT YOUR RESPONSE EXACTLY LIKE THIS:

## Overview
2-3 sentences describing what this conversation is about and who is involved.

## Key Topics Discussed
- Topic 1: brief description
- Topic 2: brief description
(list all significant topics)

## Decisions & Conclusions
- Decision or conclusion reached
(list any decisions, agreements, or conclusions. If none, write "No explicit decisions recorded.")

## Action Items
- [Owner if known] Action item description
(list any action items, tasks, or next steps mentioned. If none, write "No explicit action items.")

## Notable Ideas & Insights
- Idea or insight worth capturing
(list any interesting ideas, proposals, or strategic insights raised in the discussion)

RULES:
- Be thorough — capture ALL significant topics, not just the first few
- Use specific details from the transcript, not vague generalizations
- Attribute statements to speakers when possible
- Do NOT invent information not in the transcript
- Do NOT start with "This transcript" or "The transcript"${speakerContext}`,
        },
        {
          role: 'user',
          content: truncated,
        },
      ],
      stream: false,
      options: { temperature: 0.3 },
    }),
    signal: AbortSignal.timeout(300_000),
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status}`);
  }

  const data = await response.json() as { message?: { content?: string } };
  return data.message?.content?.trim() || '';
}

export function applySpeakerNames(
  text: string,
  segments: Array<{ start: number; end: number; text: string; speaker?: string }>,
  speakerMap: Record<string, string>,
): { text: string; segments: Array<{ start: number; end: number; text: string; speaker?: string }> } {
  let mappedText = text;
  for (const [label, name] of Object.entries(speakerMap)) {
    mappedText = mappedText.replaceAll(`[${label}]`, `[${name}]`);
  }

  const mappedSegments = segments.map(seg => ({
    ...seg,
    speaker: seg.speaker && speakerMap[seg.speaker] ? speakerMap[seg.speaker] : seg.speaker,
  }));

  return { text: mappedText, segments: mappedSegments };
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
