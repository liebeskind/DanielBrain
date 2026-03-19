export interface TranscribeSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface TranscribeResult {
  text: string;
  segments: TranscribeSegment[];
  language: string;
  duration: number;
  summary?: string;
  speakers?: Record<string, { duration: number; segments: number }>;
}

export interface TranscribeJob {
  id: string;
  status: 'pending' | 'transcribing' | 'summarizing' | 'completed' | 'failed';
  audioPath: string;
  originalFilename: string;
  fileSize: number;
  createdAt: Date;
  completedAt?: Date;
  error?: string;
  result?: TranscribeResult;
  savedToQueue?: boolean;
  queueId?: string;
  speakerMap?: Record<string, string>;
}

const jobs = new Map<string, TranscribeJob>();

const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function cleanup(): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt.getTime() < cutoff) {
      jobs.delete(id);
    }
  }
}

export function createJob(id: string, audioPath: string, originalFilename: string, fileSize: number): TranscribeJob {
  cleanup();
  const job: TranscribeJob = {
    id,
    status: 'pending',
    audioPath,
    originalFilename,
    fileSize,
    createdAt: new Date(),
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id: string): TranscribeJob | undefined {
  return jobs.get(id);
}

export function updateJob(id: string, updates: Partial<TranscribeJob>): TranscribeJob | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  Object.assign(job, updates);
  return job;
}

export function listJobs(): TranscribeJob[] {
  return Array.from(jobs.values()).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

// For tests
export function _clearJobs(): void {
  jobs.clear();
}
