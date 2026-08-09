import express from 'express';
import { requireAuth } from '../auth.js';
import { getAllSettings, setSettings, DEFAULT_SETTINGS } from '../../services/settings.js';
import config from '../../config.js';
import { isConfigured } from '../../payments/cryptomus.js';

const router = express.Router();
router.use(requireAuth);

// Editable text settings + read-only runtime/config health
router.get('/', async (req, res) => {
  const settings = await getAllSettings(true);
  res.json({
    settings,
    defaults: DEFAULT_SETTINGS,
    runtime: {
      publicUrl: config.publicUrl,
      webhookUrl: `${config.publicUrl}/api/webhook/cryptomus`,
      currency: config.shop.currency,
      pollIntervalSec: config.shop.pollIntervalSec,
      orderExpiryMin: config.shop.orderExpiryMin,
      botConfigured: Boolean(config.telegram.token),
      cryptomusConfigured: isConfigured(),
      adminTelegramIds: config.telegram.adminIds,
      supportUsername: config.telegram.supportUsername,
      env: config.env,
      missing: config.missing,
    },
  });
});

router.put('/', async (req, res) => {
  const incoming = req.body?.settings || {};
  // Only persist known keys to keep the store tidy.
  const allowed = Object.keys(DEFAULT_SETTINGS);
  const toSave = {};
  for (const k of allowed) {
    if (incoming[k] !== undefined) toSave[k] = String(incoming[k]);
  }
  if (Object.keys(toSave).length) await setSettings(toSave);
  const settings = await getAllSettings(true);
  res.json({ ok: true, settings });
});

export default router;
