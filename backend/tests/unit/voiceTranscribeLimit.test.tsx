/**
 * @jest-environment jsdom
 *
 * Owner 2026-10-26: "Transcription failed" on the chat mic. Prod logs showed
 * /api/voice/transcribe answering 413 — the base64 recording exceeded Next's default
 * 1 MB body limit after ~30-60 s of speech. The route now accepts 4 MB, the mic records
 * at a speech bitrate with a 5-minute cap, and failures say what happened.
 *
 * SECRETS: none. No network.
 */
import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import ChatVoiceButton, { MAX_RECORDING_MS, transcriptionErrorMessage, TRANSCRIPTION_UNCERTAIN_MESSAGE } from '../../../components/ChatVoiceButton';

const ROUTE = fs.readFileSync(path.join(__dirname, '../../../pages/api/voice/transcribe.ts'), 'utf8');

describe('voice transcription fits and explains itself', () => {
  it('the route raises the body limit to 4 MB (under the 4.5 MB platform cap)', () => {
    expect(ROUTE).toMatch(/export const config = \{\s*api: \{\s*bodyParser: \{ sizeLimit: '4mb' \}/);
  });

  it('a 5-minute note at 32 kbps fits the limit as base64', () => {
    const bytes = (32_000 / 8) * (MAX_RECORDING_MS / 1000);
    expect(Math.ceil(bytes / 3) * 4).toBeLessThan(4 * 1024 * 1024);
  });

  it('error messages are specific, never a bare "Transcription failed"', () => {
    expect(transcriptionErrorMessage(413)).toMatch(/too long/);
    expect(transcriptionErrorMessage(429, 'Rate limit: retry in 20s')).toBe('Rate limit: retry in 20s');
    expect(transcriptionErrorMessage(429)).toMatch(/Too many voice notes/);
    expect(transcriptionErrorMessage(401)).toMatch(/sign in again/);
    // 2026-11-20 (b3/7c): transcription is a SPEND path; a 5xx without a code is an unknown outcome, so it
    // no longer says "please try again" (was: 'Transcription failed — please try again.').
    expect(transcriptionErrorMessage(500)).toBe(TRANSCRIPTION_UNCERTAIN_MESSAGE);
  });

  it('a 5xx WITHOUT a code never invites a retry, even when the server text does', () => {
    // the route's catch-all 500 body (it can follow the paid provider call)
    const t = transcriptionErrorMessage(500, 'Transcription failed — please try again.', null);
    expect(t).toBe(TRANSCRIPTION_UNCERTAIN_MESSAGE);
    expect(t).not.toMatch(/try again/i);
  });

  it('control: a refusal the route names with a code (the AI guard, before the provider) keeps its own text', () => {
    expect(transcriptionErrorMessage(503, 'AI request protection unavailable. Please retry.', 'AI_GUARD_UNAVAILABLE'))
      .toBe('AI request protection unavailable. Please retry.');
  });

  it('an UNKNOWN coded 5xx (e.g. a future one after the provider call) is treated as uncertain, not trusted (7c)', () => {
    expect(transcriptionErrorMessage(500, 'Transcription failed, please try again', 'WHISPER_FAILED')).toBe(TRANSCRIPTION_UNCERTAIN_MESSAGE);
  });

  it('the pre-spend allowlist matches the route: the only coded 5xx it emits is AI_GUARD_UNAVAILABLE', () => {
    // Positive control on the producer: every coded 5xx literal in the route must be allowlisted in the UI.
    const read = (p: string) => require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8') as string;
    const route = read('pages/api/voice/transcribe.ts');
    const coded5xx = [...route.matchAll(/status\(5\d\d\)\.json\(\{[^}]*code:\s*'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(coded5xx).toEqual(['AI_GUARD_UNAVAILABLE']); // non-empty: the pattern matches the real line
    const ui = read('components/ChatVoiceButton.tsx');
    for (const code of coded5xx) expect(ui).toContain(`'${code}'`);

    // Coverage (7c): EVERY literal 5xx site must be either a parsed coded one or carry no `code` at all, so a
    // coded 5xx in a shape the regex above cannot read (variable payload, other quotes) fails here instead of
    // passing silently. The protection itself is the UI's inverted default; this pin forces the decision.
    const sites = [...route.matchAll(/status\(5\d\d\)\.json\(([\s\S]*?)\);/g)].map((m) => m[1]);
    expect(sites.length).toBeGreaterThanOrEqual(2); // the guard-catch 503 and the catch-all 500
    const withCode = sites.filter((body) => /\bcode\b/.test(body) || !/^\s*\{/.test(body));
    expect(withCode.length).toBe(coded5xx.length);
  });

  it("premise at the source: every AiGuardError is constructed with a status below 500 (so the route's dynamic err.status is never a 5xx)", () => {
    const read = (p: string) => require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8') as string;
    const guard = read('backend/services/ai/aiRequestGuard.ts');
    const starts = [...guard.matchAll(/new AiGuardError\(/g)].map((m) => m.index as number);
    const statuses = starts.map((at) => {
      // Known limit (7c): a site whose own status is NOT a literal could pick up a neighbour's digits inside
      // this 500-char window instead of yielding NaN. The >= 500 filter still catches any 5xx; don't over-trust.
      const m = guard.slice(at, at + 500).match(/,\s*(\d{3})\s*[,)]/); // the literal status argument
      return m ? Number(m[1]) : NaN;
    });
    expect(starts.length).toBeGreaterThanOrEqual(8); // non-vacuous: today 5 x 413 + 3 x 429
    expect(statuses.filter((s) => Number.isNaN(s))).toEqual([]); // every site has a readable literal status
    expect(statuses.filter((s) => s >= 500)).toEqual([]);
  });

  it('records at the speech bitrate, shows a timer, and stops itself at the cap', async () => {
    jest.useFakeTimers();
    const stop = jest.fn();
    const created: Array<{ options: MediaRecorderOptions | undefined }> = [];
    class FakeRecorder {
      static isTypeSupported = () => true;
      state = 'inactive';
      mimeType = 'audio/webm';
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(_s: unknown, options?: MediaRecorderOptions) { created.push({ options }); }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; stop(); }
    }
    (global as any).MediaRecorder = FakeRecorder;
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: async () => ({ getTracks: () => [] }) }, configurable: true,
    });

    render(<ChatVoiceButton onTranscription={jest.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(created[0].options?.audioBitsPerSecond).toBe(32_000);
    await act(async () => { jest.advanceTimersByTime(61_000); });
    expect(screen.getByText('1:01')).toBeTruthy();
    await act(async () => { jest.advanceTimersByTime(MAX_RECORDING_MS); });
    expect(stop).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});

describe('transcription outcome the client cannot know (rendered)', () => {
  function installRecorder() {
    class FakeRecorder {
      static isTypeSupported = () => true;
      state = 'inactive';
      mimeType = 'audio/webm';
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() { this.state = 'recording'; }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['abc'], { type: 'audio/webm' }) });
        this.onstop?.();
      }
    }
    (global as any).MediaRecorder = FakeRecorder;
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: async () => ({ getTracks: () => [] }) }, configurable: true,
    });
  }
  async function recordAndSend(fetchImpl: jest.Mock) {
    (global as any).fetch = fetchImpl;
    installRecorder();
    render(<ChatVoiceButton onTranscription={jest.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole('button')); }); // start
    await act(async () => { fireEvent.click(screen.getByRole('button')); }); // stop -> transcribe
  }

  it('lost connection → the uncertain text, not the browser error and not a retry invitation', async () => {
    await recordAndSend(jest.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await screen.findByText(TRANSCRIPTION_UNCERTAIN_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(/Failed to fetch/)).toBeNull();
  });

  it("server 500 without a code → the uncertain text, not the server's \"please try again\"", async () => {
    await recordAndSend(jest.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'Transcription failed — please try again.' }) })));
    expect(await screen.findByText(TRANSCRIPTION_UNCERTAIN_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(/please try again/i)).toBeNull();
  });

  it('control: a coded guard refusal shows its own text', async () => {
    await recordAndSend(jest.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: 'AI request protection unavailable. Please retry.', code: 'AI_GUARD_UNAVAILABLE' }) })));
    expect(await screen.findByText('AI request protection unavailable. Please retry.')).toBeTruthy();
  });
});
