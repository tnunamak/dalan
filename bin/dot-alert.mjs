#!/usr/bin/env node
// Send one ntfy alert through the bridge's configured publisher (~/.config/dot-bridge/alerts.env),
// so scheduled agents can alert the owner without handling the notification token themselves.
// Usage: dalan-alert "title" "message"
import { publishAlert } from '../src/alerts.mjs';
const [title, message] = process.argv.slice(2);
if (!title || !message) { console.error('usage: dalan-alert TITLE MESSAGE'); process.exit(2); }
await publishAlert(title, message, () => {}, { requirePublisher: true });
console.log('sent');
