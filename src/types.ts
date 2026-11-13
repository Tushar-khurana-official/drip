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
  campaign_id: string;
  lead_id: string;
  send_at: string;
  status: MessageStatus;
  /** When the server started / finished sending. */
  claimed_at?: string;
  sent_at?: string;
  /** Message id returned by WhatsApp. */
  wa_message_id?: string;
  error?: string;
}

export interface BusinessSettings {
  name: string;
}

export interface DripDoc {
  settings: BusinessSettings;
  leads: Lead[];
  campaigns: Campaign[];
  messages: Message[];
}
