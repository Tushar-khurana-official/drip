/** Drip data model. Everything belongs to one business (the app is single-tenant). */

/** The business sending the messages. Used for {shop}, {owner} and {upi} in templates. */
export interface BusinessProfile {
  name: string;
  owner: string;
  upi_id: string;
}

/* --------------------------------- CRM --------------------------------- */

export type LeadStatus = 'new' | 'contacted' | 'interested' | 'converted' | 'lost';

/** A prospective customer the shop wants to follow up with. Phone needs consent, like Customer. */
export interface Lead {
  id: string;
  shop_id: string;
  name: string;
  phone: string;
  /** When the lead agreed to get WhatsApp messages from the shop; null = no messages may be scheduled. */
  consent_given_at: string | null;
  /** Lowercase, trimmed, unique. */
  tags: string[];
  status: LeadStatus;
  source: string;
  note: string;
  created_at: string;
}

/** A reusable message. Placeholders: {name}, {shop}, {owner}, {upi}. */
export interface MessageTemplate {
  id: string;
  shop_id: string;
  name: string;
  body: string;
  /**
   * Optional: name of a Meta-approved WhatsApp template. Only used when the server sends automatically
   * through the WhatsApp Cloud API ({{1}} in that template is filled with the lead's name).
   */
  wa_template_name?: string;
  wa_language?: string;
  created_at: string;
}

export type ScheduledStatus = 'scheduled' | 'sent' | 'failed' | 'cancelled';

/** One template, to one lead, at one time. */
export interface ScheduledMessage {
  id: string;
  shop_id: string;
  lead_id: string;
  template_id: string;
  /** ISO time the message should go out. */
  send_at: string;
  status: ScheduledStatus;
  /** 'link' = owner opened WhatsApp and tapped send; 'api' = sent by the server through WhatsApp Cloud API. */
  sent_via?: 'link' | 'api';
  sent_at?: string;
  /** Exact text that was sent (filled in when it goes out). */
  text?: string;
  error?: string;
  created_at: string;
}
