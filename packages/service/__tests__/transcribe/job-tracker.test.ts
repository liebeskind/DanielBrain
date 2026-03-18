import { describe, it, expect, beforeEach } from 'vitest';
import { createJob, getJob, updateJob, listJobs, _clearJobs } from '../../src/transcribe/job-tracker.js';

describe('TranscribeJobTracker', () => {
  beforeEach(() => {
    _clearJobs();
  });

  it('creates and retrieves a job', () => {
    const job = createJob('j1', '/tmp/audio.mp3', 'meeting.mp3', 5000);
    expect(job.id).toBe('j1');
    expect(job.status).toBe('pending');
    expect(job.originalFilename).toBe('meeting.mp3');

    const retrieved = getJob('j1');
    expect(retrieved).toEqual(job);
  });

  it('returns undefined for unknown job', () => {
    expect(getJob('nonexistent')).toBeUndefined();
  });

  it('updates a job', () => {
    createJob('j1', '/tmp/a.mp3', 'a.mp3', 1000);
    const updated = updateJob('j1', { status: 'transcribing' });
    expect(updated?.status).toBe('transcribing');
    expect(getJob('j1')?.status).toBe('transcribing');
  });

  it('update returns undefined for unknown job', () => {
    expect(updateJob('nope', { status: 'failed' })).toBeUndefined();
  });

  it('lists jobs sorted by newest first', () => {
    const now = Date.now();
    const j1 = createJob('j1', '/tmp/a.mp3', 'a.mp3', 1000);
    j1.createdAt = new Date(now - 3000);
    const j2 = createJob('j2', '/tmp/b.mp3', 'b.mp3', 2000);
    j2.createdAt = new Date(now - 2000);
    const j3 = createJob('j3', '/tmp/c.mp3', 'c.mp3', 3000);
    j3.createdAt = new Date(now - 1000);

    const list = listJobs();
    expect(list).toHaveLength(3);
    expect(list[0].id).toBe('j3');
    expect(list[2].id).toBe('j1');
  });

  it('stores result on completion', () => {
    createJob('j1', '/tmp/a.mp3', 'a.mp3', 1000);
    updateJob('j1', {
      status: 'completed',
      completedAt: new Date(),
      result: {
        text: 'Hello world',
        segments: [{ start: 0, end: 1.5, text: 'Hello world' }],
        language: 'en',
        duration: 1.5,
        summary: 'A greeting.',
      },
    });

    const job = getJob('j1');
    expect(job?.status).toBe('completed');
    expect(job?.result?.text).toBe('Hello world');
    expect(job?.result?.summary).toBe('A greeting.');
    expect(job?.result?.segments).toHaveLength(1);
  });

  it('tracks save-to-queue status', () => {
    createJob('j1', '/tmp/a.mp3', 'a.mp3', 1000);
    updateJob('j1', { savedToQueue: true, queueId: 'q-123' });

    const job = getJob('j1');
    expect(job?.savedToQueue).toBe(true);
    expect(job?.queueId).toBe('q-123');
  });
});
