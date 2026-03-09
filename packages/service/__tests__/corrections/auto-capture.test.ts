import { describe, it, expect, vi, beforeEach } from 'vitest';
import { captureFromApproval, captureFromRejection } from '../../src/corrections/auto-capture.js';

vi.mock('../../src/corrections/store.js', () => ({
  createCorrectionExample: vi.fn().mockResolvedValue('ce-1'),
}));

import { createCorrectionExample } from '../../src/corrections/store.js';

const mockPool = { query: vi.fn() };

const baseProposal = {
  id: 'p-1',
  proposal_type: 'entity_enrichment',
  status: 'approved' as const,
  entity_id: 'e-1',
  title: 'LinkedIn URL for Jamie Farrell',
  description: 'Found via SerpAPI: "site:linkedin.com/in "Jamie Farrell" "Pearson""',
  proposed_data: { linkedin_url: 'https://linkedin.com/in/tessa-gray' },
  current_data: null,
  auto_applied: false,
  reviewer_notes: 'Manually corrected URL',
  source: 'linkedin_enricher',
  applied_at: null,
  created_at: new Date(),
  updated_at: new Date(),
};

describe('auto-capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('captureFromApproval', () => {
    it('captures correction when URL was changed', async () => {
      const correctedData = { linkedin_url: 'https://linkedin.com/in/jamienachtfarrell' };

      const id = await captureFromApproval(baseProposal, correctedData, mockPool as any);

      expect(id).toBe('ce-1');
      expect(createCorrectionExample).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'linkedin_search',
          input_context: expect.objectContaining({
            entity_name: 'Jamie Farrell',
            company_context: expect.arrayContaining(['Pearson']),
          }),
          actual_output: { linkedin_url: 'https://linkedin.com/in/tessa-gray' },
          expected_output: { linkedin_url: 'https://linkedin.com/in/jamienachtfarrell' },
          entity_id: 'e-1',
          proposal_id: 'p-1',
          tags: expect.arrayContaining(['auto-captured', 'approval-correction']),
        }),
        mockPool,
      );
    });

    it('returns null when no corrected data provided', async () => {
      const id = await captureFromApproval(baseProposal, null, mockPool as any);
      expect(id).toBeNull();
      expect(createCorrectionExample).not.toHaveBeenCalled();
    });

    it('returns null when URL did not change', async () => {
      const correctedData = { linkedin_url: 'https://linkedin.com/in/tessa-gray' };
      const id = await captureFromApproval(baseProposal, correctedData, mockPool as any);
      expect(id).toBeNull();
      expect(createCorrectionExample).not.toHaveBeenCalled();
    });

    it('returns null for non-enrichment proposals', async () => {
      const proposal = { ...baseProposal, proposal_type: 'entity_link' };
      const id = await captureFromApproval(proposal, { some: 'data' }, mockPool as any);
      expect(id).toBeNull();
    });

    it('handles errors gracefully', async () => {
      (createCorrectionExample as any).mockRejectedValueOnce(new Error('DB error'));

      const id = await captureFromApproval(
        baseProposal,
        { linkedin_url: 'https://linkedin.com/in/correct' },
        mockPool as any,
      );

      expect(id).toBeNull();
    });
  });

  describe('captureFromRejection', () => {
    it('captures rejection as negative example', async () => {
      const id = await captureFromRejection(baseProposal, 'Wrong person entirely', mockPool as any);

      expect(id).toBe('ce-1');
      expect(createCorrectionExample).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'linkedin_search',
          actual_output: { linkedin_url: 'https://linkedin.com/in/tessa-gray' },
          expected_output: { rejected: true },
          explanation: 'Wrong person entirely',
          tags: expect.arrayContaining(['auto-captured', 'rejection']),
        }),
        mockPool,
      );
    });

    it('returns null for non-enrichment proposals', async () => {
      const proposal = { ...baseProposal, proposal_type: 'entity_merge' };
      const id = await captureFromRejection(proposal, 'no', mockPool as any);
      expect(id).toBeNull();
    });

    it('handles errors gracefully', async () => {
      (createCorrectionExample as any).mockRejectedValueOnce(new Error('DB error'));

      const id = await captureFromRejection(baseProposal, 'wrong', mockPool as any);
      expect(id).toBeNull();
    });
  });
});
