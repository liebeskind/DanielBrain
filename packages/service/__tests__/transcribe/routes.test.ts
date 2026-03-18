import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAdminRoutes } from '../../src/admin/routes.js';

vi.mock('../../src/parsers/index.js', () => ({
  parseFile: vi.fn(),
}));

vi.mock('../../src/transcribe/job-tracker.js', () => ({
  createJob: vi.fn(),
  getJob: vi.fn(),
  updateJob: vi.fn(),
  listJobs: vi.fn(),
}));

vi.mock('../../src/transcribe/service.js', () => ({
  runTranscription: vi.fn(),
  formatAsSrt: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual as object,
    default: {
      ...(actual as any),
      promises: {
        ...(actual as any).promises,
        writeFile: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
});

import { createJob, getJob, updateJob, listJobs } from '../../src/transcribe/job-tracker.js';
import { runTranscription, formatAsSrt } from '../../src/transcribe/service.js';

const mockCreateJob = vi.mocked(createJob);
const mockGetJob = vi.mocked(getJob);
const mockUpdateJob = vi.mocked(updateJob);
const mockListJobs = vi.mocked(listJobs);
const mockRunTranscription = vi.mocked(runTranscription);
const mockFormatAsSrt = vi.mocked(formatAsSrt);

const mockPool = { query: vi.fn() };

const baseConfig = {
  databaseUrl: 'postgres://localhost/test',
  brainAccessKey: 'test-key',
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
  extractionModel: 'llama3.3:70b',
  chatModel: 'llama3.3:70b',
  mcpPort: 3000,
  pollIntervalMs: 5000,
  batchSize: 5,
  maxRetries: 3,
  rawFilesDir: '/tmp/test-raw-files',
  whisperModel: 'large-v3',
  transcribeDir: '/tmp/test-transcriptions',
};

function getHandler(router: ReturnType<typeof createAdminRoutes>, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  const handlers = layer.route.stack;
  return handlers[handlers.length - 1].handle;
}

describe('Transcribe Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/transcribe/:id', () => {
    it('returns job status', async () => {
      const job = {
        id: 'j1',
        status: 'transcribing' as const,
        audioPath: '/tmp/a.mp3',
        originalFilename: 'meeting.mp3',
        fileSize: 5000,
        createdAt: new Date(),
      };
      mockGetJob.mockReturnValueOnce(job);

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/transcribe/:id');

      const req = { params: { id: 'j1' } };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      expect(res.json).toHaveBeenCalledWith(job);
    });

    it('returns 404 for unknown job', async () => {
      mockGetJob.mockReturnValueOnce(undefined);

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/transcribe/:id');

      const req = { params: { id: 'nope' } };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('GET /api/transcribe', () => {
    it('returns recent jobs list', async () => {
      mockListJobs.mockReturnValueOnce([
        { id: 'j1', status: 'completed', audioPath: '/tmp/a.mp3', originalFilename: 'a.mp3', fileSize: 1000, createdAt: new Date() },
      ] as any);

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/transcribe');

      const res = { json: vi.fn() };
      await handler({} as any, res as any);

      expect(res.json).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({ id: 'j1' }),
      ]));
    });
  });

  describe('POST /api/transcribe/:id/save', () => {
    it('saves completed transcription to queue', async () => {
      mockGetJob.mockReturnValueOnce({
        id: 'j1',
        status: 'completed',
        audioPath: '/tmp/a.mp3',
        originalFilename: 'meeting.mp3',
        fileSize: 5000,
        createdAt: new Date(),
        result: {
          text: 'Hello world transcript.',
          segments: [{ start: 0, end: 2, text: 'Hello world transcript.' }],
          language: 'en',
          duration: 120,
          summary: 'A greeting was made.',
        },
      });
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'q-456' }] });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'post', '/api/transcribe/:id/save');

      const req = { params: { id: 'j1' }, body: { title: 'Team Meeting' } };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      expect(res.json).toHaveBeenCalledWith({ id: 'q-456', status: 'queued' });
      expect(mockUpdateJob).toHaveBeenCalledWith('j1', { savedToQueue: true, queueId: 'q-456' });

      const insertCall = mockPool.query.mock.calls[0];
      expect(insertCall[0]).toContain('INSERT INTO queue');
      expect(insertCall[1][0]).toBe('Hello world transcript.');
      const meta = JSON.parse(insertCall[1][1]);
      expect(meta.title).toBe('Team Meeting');
      expect(meta.thought_type).toBe('meeting_transcript');
      expect(meta.audio_duration).toBe(120);
    });

    it('returns 400 when transcription not completed', async () => {
      mockGetJob.mockReturnValueOnce({
        id: 'j1',
        status: 'transcribing',
        audioPath: '/tmp/a.mp3',
        originalFilename: 'a.mp3',
        fileSize: 1000,
        createdAt: new Date(),
      });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'post', '/api/transcribe/:id/save');

      const req = { params: { id: 'j1' }, body: {} };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns already_saved if previously saved', async () => {
      mockGetJob.mockReturnValueOnce({
        id: 'j1',
        status: 'completed',
        audioPath: '/tmp/a.mp3',
        originalFilename: 'a.mp3',
        fileSize: 1000,
        createdAt: new Date(),
        result: { text: 'Hi', segments: [], language: 'en', duration: 5 },
        savedToQueue: true,
        queueId: 'q-existing',
      });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'post', '/api/transcribe/:id/save');

      const req = { params: { id: 'j1' }, body: {} };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      expect(res.json).toHaveBeenCalledWith({ id: 'q-existing', status: 'already_saved' });
    });
  });

  describe('GET /api/transcribe/:id/download', () => {
    const completedJob = {
      id: 'j1',
      status: 'completed' as const,
      audioPath: '/tmp/a.mp3',
      originalFilename: 'meeting.mp3',
      fileSize: 5000,
      createdAt: new Date(),
      result: {
        text: 'Full transcript text.',
        segments: [{ start: 0, end: 2, text: 'Full transcript text.' }],
        language: 'en',
        duration: 120,
        summary: 'A summary.',
      },
    };

    it('downloads as txt with summary', async () => {
      mockGetJob.mockReturnValueOnce(completedJob);

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/transcribe/:id/download');

      const res = { setHeader: vi.fn(), send: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() };
      const req = { params: { id: 'j1' }, query: { format: 'txt' } };

      await handler(req as any, res as any);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain');
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('SUMMARY'));
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Full transcript text.'));
    });

    it('downloads as json', async () => {
      mockGetJob.mockReturnValueOnce(completedJob);

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/transcribe/:id/download');

      const res = { setHeader: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() };
      const req = { params: { id: 'j1' }, query: { format: 'json' } };

      await handler(req as any, res as any);

      expect(res.json).toHaveBeenCalledWith(completedJob.result);
    });

    it('downloads as srt', async () => {
      mockGetJob.mockReturnValueOnce(completedJob);
      mockFormatAsSrt.mockReturnValueOnce('1\n00:00:00,000 --> 00:00:02,000\nFull transcript text.\n');

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/transcribe/:id/download');

      const res = { setHeader: vi.fn(), send: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() };
      const req = { params: { id: 'j1' }, query: { format: 'srt' } };

      await handler(req as any, res as any);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/srt');
      expect(mockFormatAsSrt).toHaveBeenCalledWith(completedJob.result.segments);
    });

    it('returns 404 for incomplete job', async () => {
      mockGetJob.mockReturnValueOnce({
        id: 'j1', status: 'transcribing', audioPath: '/tmp/a.mp3',
        originalFilename: 'a.mp3', fileSize: 1000, createdAt: new Date(),
      });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/transcribe/:id/download');

      const res = { setHeader: vi.fn(), send: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() };
      const req = { params: { id: 'j1' }, query: {} };

      await handler(req as any, res as any);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});
