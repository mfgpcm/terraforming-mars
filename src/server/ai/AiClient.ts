import {URL} from 'node:url';
import {Agent, fetch} from 'undici';

export interface LegalAction {
  action_id: string;
  type: string;
  title: string;
  payload?: Record<string, unknown>;
}

export interface MoveRequestPayload {
  game_id: string;
  player_id: string;
  state: Record<string, unknown>;
  legal_actions: Array<LegalAction>;
  metadata: {
    schema_version: number;
  };
  last_error?: string;
}

export interface MoveResponsePayload {
  action_id?: string;
  parameters?: Record<string, unknown>;
  input_response?: Record<string, unknown>;
  debug?: {
    policy_logits?: Array<number>;
    value_estimate?: number;
  };
}

const AI_SERVER_URL = process.env.AI_SERVER_URL ?? 'http://localhost:8000';
const DEFAULT_AI_TIMEOUT_MS = 600000;
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS ?? DEFAULT_AI_TIMEOUT_MS.toString());

const _agent = new Agent({headersTimeout: AI_TIMEOUT_MS, bodyTimeout: AI_TIMEOUT_MS});

export class AiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string = AI_SERVER_URL, timeoutMs: number = AI_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  public async requestMove(payload: MoveRequestPayload): Promise<MoveResponsePayload> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = new URL('/move', this.baseUrl).toString();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
        dispatcher: _agent,
      } as Parameters<typeof fetch>[1]);

      if (!res.ok) {
        throw new Error(`AI server returned status ${res.status}`);
      }

      return (await res.json()) as MoveResponsePayload;
    } finally {
      clearTimeout(timeout);
    }
  }
}
