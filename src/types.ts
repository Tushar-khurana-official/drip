/** Drip data model. One Drip instance = one business and one WhatsApp number. */

export type LeadStatus = 'new' | 'contacted' | 'interested' | 'converted' | 'lost';

export interface Lead {
  id: string;
  name: string;
  /** Digits with country code, e.g. "919876543210". */
  phone: string;
  /** Lowercase, trimmed, unique. */
  tags: string[];
  status: LeadStatus;
  source: string;
  notes: string;
  /** When the lead agreed to receive WhatsApp messages. Messages are only scheduled for opted-in leads. */
  opted_in_at: string | null;
  /** Last WhatsApp message received from the lead (free-text replies allowed for 24 h after). */
  last_inbound_at?: string | null;
  created_at: string;
  updated_at: string;
}

/* ------------------------- WhatsApp templates (Meta) ------------------------- */

export interface WaButton {
  type: string; // QUICK_REPLY | URL | PHONE_NUMBER | COPY_CODE | ...
  text?: string;
  url?: string;
  phone_number?: string;
}

export interface WaComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS' | string;
  format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION' | string;
  text?: string;
  buttons?: WaButton[];
  example?: Record<string, unknown>;
}

/** A message template as the WhatsApp API returns it. */
export interface WaTemplate {
  id?: string;
  name: string;
  language: string;
  status: string; // APPROVED | PENDING | REJECTED | PAUSED | ...
  category?: string;
  parameter_format?: 'POSITIONAL' | 'NAMED' | string;
  components: WaComponent[];
}

/* ------------------------------ campaigns ------------------------------ */

/** Where a template variable's value comes from. */
export type VarSource =
  | { kind: 'name' }
  | { kind: 'first_name' }
  | { kind: 'phone' }
  | { kind: 'text'; text: string };

/** A template sent to a set of leads at one time. */
export interface Campaign {
  id: string;
  name: string;
  /** Snapshot of the template when the campaign was created. */
  template: WaTemplate;
  /** Variable key (see templateVariables) -> value source. */
  mapping: Record<string, VarSource>;
  /** Link to the image / video / document when the template header is media. */
  header_media_url: string | null;
  send_at: string;
  created_at: string;
}

export type MessageStatus = 'scheduled' | 'sending' | 'sent' | 'failed' | 'cancelled';

/** One template message to one lead. */
export interface Message {
  id: string;
  /** Campaign that created it, or "" for automation messages. */
  campaign_id: string;
  /** Set when the message comes from a tag automation. */
  sequence_id?: string;
  step_id?: string;
  lead_id: string;
  send_at: string;
  status: MessageStatus;
  /** When the server started / finished sending. */
  claimed_at?: string;
  sent_at?: string;
  /** Message id returned by WhatsApp. */
  wa_message_id?: string;
  /** Text the lead received (template filled in), saved when sent. */
  text?: string;
  /** From WhatsApp status webhooks. */
  delivered_at?: string;
  read_at?: string;
  error?: string;
}

/**
 * One entry in a lead's chat that is not a scheduled template:
 * - in:   a WhatsApp message from the lead (webhook)
 * - out:  a free-text WhatsApp reply sent from Drip
 * - note: something the team wrote down (call, visit, what was discussed); never sent
 */
export interface ChatEntry {
  id: string;
  lead_id: string;
  kind: 'in' | 'out' | 'note';
  text: string;
  at: string;
  /** WhatsApp message id (in / out). */
  wa_message_id?: string;
  /** For in: message type when it is not text (image, audio, ...). */
  media_type?: string;
  /** For out: delivery status. */
  status?: 'sent' | 'delivered' | 'read' | 'failed';
  error?: string;
}

/* ------------------------- tags and automations ------------------------- */

export const TAG_COLORS = ['indigo', 'emerald', 'amber', 'rose', 'sky', 'violet', 'teal', 'orange', 'slate'] as const;
export type TagColor = (typeof TAG_COLORS)[number];

/** A tag the business defined (name, colour, what it means). Leads can still carry ad-hoc tags too. */
export interface TagDef {
  name: string;
  color: TagColor;
  description: string;
  created_at: string;
}

/** One message in a tag automation. */
export interface SequenceStep {
  id: string;
  /** Days to wait: after the tag is added (first step) or after the previous step. 0 = same day. */
  delay_days: number;
  /** Time of day to send, India time, "HH:MM". */
  time: string;
  template: WaTemplate;
  mapping: Record<string, VarSource>;
  header_media_url: string | null;
}

/** Messages sent automatically after a tag is added to a lead. */
export interface Sequence {
  id: string;
  tag: string;
  enabled: boolean;
  /** Cancel the remaining steps when the lead replies on WhatsApp. */
  stop_on_reply: boolean;
  steps: SequenceStep[];
  updated_at: string;
}

export interface BusinessSettings {
  name: string;
}

export interface DripDoc {
  settings: BusinessSettings;
  leads: Lead[];
  campaigns: Campaign[];
  messages: Message[];
  chats: ChatEntry[];
  tag_defs: TagDef[];
  sequences: Sequence[];
}
