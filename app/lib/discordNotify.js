'use strict';

// Sends block-found alerts to a Discord webhook, if one is saved in Settings
// (Setup tab). Off by default - nothing is ever sent until a URL is
// configured. Uses Discord's plain webhook POST body ({ content }) since a
// block-found alert doesn't need anything richer than a short message - see
// https://discord.com/developers/docs/resources/webhook#execute-webhook.

const config = require('./config');

const TIMEOUT_MS = 8000;

async function postTo(url, content) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Discord responded with HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// Fire-and-forget, used by the block-found hooks (lib/blocks.js,
// lib/tariBlocks.js) - a failed notification shouldn't ever affect mining,
// so this only logs on failure rather than throwing.
async function send(content) {
  const { discordWebhookUrl } = config.readSettings();
  if (!discordWebhookUrl) return;
  try {
    await postTo(discordWebhookUrl, content);
  } catch (err) {
    console.error('[discordNotify] failed to send:', err.message);
  }
}

// Used by the Settings tab's "Send Test Notification" button - throws on
// failure so the button can show the user what actually went wrong, and
// accepts an explicit URL so a webhook can be tried before it's saved.
async function sendTest(url) {
  const target = (url || config.readSettings().discordWebhookUrl || '').trim();
  if (!target) {
    const err = new Error('No webhook URL configured or provided.');
    err.statusCode = 400;
    throw err;
  }
  await postTo(target, '🔔 Test notification from Triple X - your Discord webhook is working!');
}

module.exports = { send, sendTest };
