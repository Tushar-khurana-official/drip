import type { BusinessProfile, Lead, MessageTemplate, ScheduledMessage } from '../types.js';

/** Everything this Drip instance keeps, saved as one document. */
export interface DripData {
  profile: BusinessProfile;
  leads: Lead[];
  templates: MessageTemplate[];
  scheduled: ScheduledMessage[];
}

/** What happened to one scheduled message the server tried to send (kept apart from DripData). */
export interface SendResult {
  id: string;
  status: 'sending' | 'sent' | 'failed';
  sent_via: 'api';
  sent_at?: string;
  text?: string;
  error?: string;
}
