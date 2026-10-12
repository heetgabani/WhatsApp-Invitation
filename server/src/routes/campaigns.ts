import { Router, Request, Response } from 'express';
import { CampaignService, DuplicateCampaignError } from '../services/campaignService.js';
import { queueManager } from '../queue/sendingQueue.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * List campaigns
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const list = CampaignService.listCampaigns(limit, offset);
    res.json({ success: true, campaigns: list });
  } catch (err: any) {
    logger.error('campaign', `Failed listing campaigns: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Create new campaign
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const result = await CampaignService.createCampaign(req.body);
    res.json({ success: true, ...result });
  } catch (err: any) {
    logger.error('campaign', `Campaign creation failed: ${err.message}`);
    if (err instanceof DuplicateCampaignError) {
      return res.status(409).json({
        error: err.message,
        code: 'DUPLICATE_CAMPAIGN',
        existingCampaignId: err.existingCampaignId,
        existingStatus: err.existingStatus
      });
    }
    res.status(400).json({ error: err.message });
  }
});

/**
 * Get single campaign with recipients
 */
router.get('/:id', (req: Request, res: Response) => {
  try {
    const campaign = CampaignService.getCampaign(req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    res.json({ success: true, campaign });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Delete campaign
 */
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const success = CampaignService.deleteCampaign(req.params.id);
    res.json({ success });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Retry failed recipients for this campaign
 */
router.post('/:id/retry', async (req: Request, res: Response) => {
  try {
    const result = await queueManager.retryFailed(req.params.id, {
      includeUncertain: req.body?.includeUncertain === true
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Export campaign report as CSV
 */
router.get('/:id/export/csv', (req: Request, res: Response) => {
  try {
    const csvData = CampaignService.exportCampaignCsv(req.params.id);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="campaign_${req.params.id}_report.csv"`);
    res.send(csvData);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Export campaign report as JSON
 */
router.get('/:id/export/json', (req: Request, res: Response) => {
  try {
    const jsonData = CampaignService.exportCampaignJson(req.params.id);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="campaign_${req.params.id}_report.json"`);
    res.json(jsonData);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;

