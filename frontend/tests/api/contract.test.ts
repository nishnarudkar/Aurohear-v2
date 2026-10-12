/**
 * Cross-stack contract: the adapter's wire shapes must match the backend's OpenAPI
 * schema (frontend/src/api/openapi.json, kept current by a backend test).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { toTrialCreate } from '../../src/api';
import type { AbortReason, TestRole, TrialPhase } from '../../src/session';
import { sampleRecord } from './fixtures';

interface JsonSchema {
  properties?: Record<string, unknown>;
  required?: string[];
  enum?: string[];
}
const openapi = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../src/api/openapi.json', import.meta.url)), 'utf-8'),
) as { components: { schemas: Record<string, JsonSchema> }; paths: Record<string, Record<string, unknown>> };
const schema = (name: string): JsonSchema => {
  const s = openapi.components.schemas[name];
  if (!s) throw new Error(`schema ${name} missing from openapi.json`);
  return s;
};
const props = (name: string): string[] => Object.keys(schema(name).properties ?? {}).sort();

// Exhaustive runtime lists of the client's union types (TS errors if one is missing).
const CLIENT_ABORT_REASONS: Record<AbortReason, true> = {
  user: true,
  context_suspended: true,
  context_closed: true,
  context_interrupted: true,
  device_change: true,
  procedure_error: true,
  stimulus_error: true,
};
const CLIENT_PHASES: Record<TrialPhase, true> = {
  familiarisation: true,
  descent: true,
  ascent: true,
  qc_probe: true,
  catch: true,
};
const CLIENT_ROLES: Record<TestRole, true> = { initial: true, retest: true, verification: true };


describe('API contract (openapi.json)', () => {
  it('TrialCreate: the adapter sends exactly the schema fields, including every required one', () => {
    const sent = Object.keys(toTrialCreate(sampleRecord)).sort();
    expect(sent).toEqual(props('TrialCreate'));
    for (const r of schema('TrialCreate').required ?? []) expect(sent).toContain(r);
  });

  it('PresentationOut has exactly the fields the adapter parses', () => {
    expect(props('PresentationOut')).toEqual(['ear', 'frequency_hz', 'level_db_hl', 'phase', 'test_role']);
  });

  it('TrialAccepted / SessionState carry next_presentation and protocol_complete', () => {
    for (const name of ['TrialAccepted', 'SessionState']) {
      expect(props(name)).toEqual(expect.arrayContaining(['next_presentation', 'protocol_complete']));
    }
    expect(props('TrialAccepted')).toEqual(expect.arrayContaining(['trial', 'advanced_protocol', 'idempotent_replay']));
  });

  it('every client abort reason is accepted by the server', () => {
    const server = new Set(schema('AbortReason').enum);
    for (const r of Object.keys(CLIENT_ABORT_REASONS)) expect(server, r).toContain(r);
  });

  it('client phases and roles are exactly the server enums', () => {
    expect(new Set(schema('Phase').enum)).toEqual(new Set(Object.keys(CLIENT_PHASES)));
    expect(new Set(schema('SearchRole').enum)).toEqual(new Set(Object.keys(CLIENT_ROLES)));
  });

  it('the endpoints the adapter calls exist with the right methods', () => {
    const p = openapi.paths;
    expect(Object.keys(p['/api/v1/sessions'] ?? {})).toContain('post');
    expect(Object.keys(p['/api/v1/sessions/{session_id}'] ?? {})).toContain('get');
    expect(Object.keys(p['/api/v1/sessions/{session_id}/trials'] ?? {})).toContain('post');
    expect(Object.keys(p['/api/v1/sessions/{session_id}/finalize'] ?? {})).toContain('post');
    expect(Object.keys(p['/api/v1/sessions/{session_id}/abort'] ?? {})).toContain('post');
    expect(Object.keys(p['/api/v1/sessions/{session_id}/feedback'] ?? {})).toContain('post');
  });

  it('ClassificationOut carries the fields the frontend type declares', () => {
    expect(props('SessionResults')).toContain('classification');
    expect(props('ClassificationOut')).toEqual(
      expect.arrayContaining([
        'band', 'p_hearing_loss', 'who_grade_better_ear', 'bsa_descriptor_right', 'bsa_descriptor_left',
        'referral', 'statement', 'caveats', 'overrides_applied', 'qc_composite', 'confidence', 'model_version',
      ]),
    );
    expect(new Set(schema('LikelihoodBand').enum)).toEqual(new Set(['low', 'medium', 'high', 'indeterminate']));
  });

  it('the participant feedback response is a receipt only — never NLP output', () => {
    const post = openapi.paths['/api/v1/sessions/{session_id}/feedback']?.['post'] as {
      responses: Record<string, { content: { 'application/json': { schema: { $ref: string } } } }>;
    };
    const ref = post.responses['201']!.content['application/json'].schema.$ref;
    expect(ref.endsWith('/FeedbackReceipt')).toBe(true);
    expect(props('FeedbackReceipt')).toEqual(['id', 'session_id', 'submitted_at']);
    // Insight endpoints exist but are admin-only (enforced and tested server-side).
    expect(Object.keys(openapi.paths['/api/v1/sessions/{session_id}/insights'] ?? {})).toContain('get');
  });

  it('SessionCreate accepts the fields the adapter documents', () => {
    expect(props('SessionCreate')).toEqual(
      [
        'better_ear', 'calibration', 'client_time_origin_ms', 'consent_version', 'device', 'environment',
        'frequency_caps_db_hl', 'mode', 'participant_id', 'profile_cap_db_hl', 'supervision',
      ].sort(),
    );
  });
});
