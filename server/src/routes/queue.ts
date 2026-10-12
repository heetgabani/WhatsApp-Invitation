import { Router, Request, Response } from 'express';
import { queueManager } from '../queue/sendingQueue.js';

const router = Router();

/**
 * Get live queue status
 */
router.get('/status', (req: Request, res: Response) => {
  const status = queueManager.getStatus();
  res.json({ success: true, status });
});

/**
 * Start campaign
 */
router.post('/start', async (req: Request, res: Response) => {
  const { campaignId } = req.body;
  if (!campaignId) {
    return res.status(400).json({ error: 'campaignId is required' });
  }

  const result = await queueManager.startCampaign(campaignId);
  if (!result.success) {
    return res.status(400).json(result);
  }

  res.json(result);
});

/**
 * Pause running campaign
 */
router.post('/pause', (req: Request, res: Response) => {
  const result = queueManager.pauseCampaign();
  res.json(result);
});

/**
 * Resume paused campaign
 */
router.post('/resume', async (req: Request, res: Response) => {
  const result = await queueManager.resumeCampaign();
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

/**
 * Cancel campaign
 */
router.post('/cancel', (req: Request, res: Response) => {
  const result = queueManager.cancelCampaign();
  res.json(result);
});

export default router;

