import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  areRequiredRequestAnswersComplete,
  answerInputSecurityAttributes,
  buildPendingRequestResponse,
  defaultAutofocusDecision,
  hasValidMcpResponsePayload,
  isMcpResponseContentValid,
  normalizeRequestQuestions,
  PendingRequestSurface,
  requestKind,
  supportedRequestDecisions,
} from '../src/renderer/session/PendingRequestSurface.js';
import type { NativePendingRequest } from '../src/renderer/session/sessionTypes.js';

function request(overrides: Partial<NativePendingRequest> = {}): NativePendingRequest {
  return {
    id: 'request-1',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    itemId: null,
    generationId: 'generation-1',
    type: 'command',
    status: 'pending',
    payload: { command: ['/bin/pwd'], availableDecisions: ['accept', 'decline', 'cancel'] },
    response: null,
    containsSecret: false,
    expiresAt: null,
    createdAt: '2026-07-13T00:00:00.000Z',
    resolvedAt: null,
    ...overrides,
  };
}

const canonicalMcpCommon = { threadId: 'thread-1', turnId: 'turn-1', serverName: 'node_repl', _meta: null } as const;

function canonicalRuiPayload(questions: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'rui-item-1',
    questions,
    autoResolutionMs: null,
    ...overrides,
  };
}

describe('PendingRequestSurface fail-closed control plane', () => {
  it('classifies only the renderer tagged-union spellings and never upgrades substring lookalikes', () => {
    expect(requestKind(request({ type: 'command' }))).toBe('command');
    expect(requestKind(request({ type: 'file' }))).toBe('file');
    expect(requestKind(request({ type: 'permissions' }))).toBe('permissions');
    expect(requestKind(request({ type: 'userInput' }))).toBe('request_user_input');
    expect(requestKind(request({ type: 'request_user_input' }))).toBe('request_user_input');
    expect(requestKind(request({ type: 'MCP' }))).toBe('mcp');
    expect(requestKind(request({ type: 'mcp' }))).toBe('mcp');
    expect(requestKind(request({ type: 'provider-file-preview' }))).toBe('unknown');
    expect(requestKind(request({ type: 'unexpected-exec' }))).toBe('unknown');
  });

  it('withholds allow decisions when command or file details are incomplete', () => {
    const incompleteCommand = request({ payload: { availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] } });
    const incompleteFile = request({ type: 'file', payload: { availableDecisions: ['accept', 'decline'] } });

    expect(supportedRequestDecisions(incompleteCommand)).toEqual(['decline', 'cancel']);
    expect(supportedRequestDecisions(incompleteFile)).toEqual(['decline', 'cancel']);

    const html = renderToStaticMarkup(<PendingRequestSurface language="en-US" request={incompleteCommand} onRespond={() => undefined} />);
    expect(html).toContain('Decline');
    expect(html).not.toContain('Allow once');
    expect(html).not.toContain('Allow for session');
  });

  it('keeps commands fail-closed but offers one-shot accept for canonical linked file approvals without advertised decisions', () => {
    const command = request({ payload: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', startedAtMs: 1, command: '/bin/pwd', cwd: '/tmp' } });
    const file = request({
      type: 'file',
      payload: {
        threadId: '019f49b1-3caa-71d3-b23b-9f6e8d92d55d',
        turnId: '019f49b1-3d28-7842-86e7-e2e5250e4045',
        itemId: 'call_rP0rUQi7NPoKwmcyT5mDhYkk',
        startedAtMs: 1783647900197,
        reason: null,
        grantRoot: null,
      },
    });

    expect(supportedRequestDecisions(command)).toEqual(['decline', 'cancel']);
    expect(supportedRequestDecisions(file)).toEqual(['accept', 'decline', 'cancel']);
    expect(buildPendingRequestResponse(file, { decision: ['accept'] })).toEqual({ type: 'file', decision: 'accept' });
    expect(buildPendingRequestResponse(file, { decision: ['decline'] })).toEqual({ type: 'file', decision: 'decline' });

    const html = renderToStaticMarkup(<PendingRequestSurface language="en-US" request={file} onRespond={() => undefined} />);
    expect(html).toContain('Decline');
    expect(html).toContain('Cancel');
    expect(html).toContain('Allow once');
    expect(html).not.toContain('Allow for session');
  });

  it('accepts canonical linked file approvals when optional reason and grantRoot fields are omitted', () => {
    const file = request({
      type: 'file',
      payload: {
        threadId: '019f49b1-3caa-71d3-b23b-9f6e8d92d55d',
        turnId: '019f49b1-3d28-7842-86e7-e2e5250e4045',
        itemId: 'call_rP0rUQi7NPoKwmcyT5mDhYkk',
        startedAtMs: 1783647900197,
      },
    });

    expect(supportedRequestDecisions(file)).toEqual(['accept', 'decline', 'cancel']);
    expect(buildPendingRequestResponse(file, { decision: ['accept'] })).toEqual({ type: 'file', decision: 'accept' });
  });

  it('never exposes acceptForSession for file approvals even when the provider advertises it', () => {
    const file = request({
      type: 'file',
      payload: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'file-item-1',
        startedAtMs: 1,
        availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
      },
    });

    expect(supportedRequestDecisions(file)).toEqual(['accept', 'decline', 'cancel']);
    expect(() => buildPendingRequestResponse(file, { decision: ['acceptForSession'] })).toThrow('not safely available');

    const sessionOnly = request({
      ...file,
      payload: { ...file.payload, availableDecisions: ['acceptForSession'] },
    });
    expect(supportedRequestDecisions(sessionOnly)).toEqual(['decline', 'cancel']);
    expect(() => buildPendingRequestResponse(sessionOnly, { decision: ['accept'] })).toThrow('not safely available');
  });

  it('withholds advertised file accept when grantRoot requests broader scope', () => {
    const file = request({
      type: 'file',
      payload: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'file-item-1',
        startedAtMs: 1,
        grantRoot: '/tmp/project',
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
    });

    expect(supportedRequestDecisions(file)).toEqual(['decline', 'cancel']);
    expect(() => buildPendingRequestResponse(file, { decision: ['accept'] })).toThrow('not safely available');
    expect(buildPendingRequestResponse(file, { decision: ['decline'] })).toEqual({ type: 'file', decision: 'decline' });

    const html = renderToStaticMarkup(<PendingRequestSurface language="en-US" request={file} onRespond={() => undefined} />);
    expect(html).toContain('Decline');
    expect(html).toContain('Cancel');
    expect(html).not.toContain('Allow once');
  });

  it('keeps non-canonical MCP payloads fail-closed so Renderer never offers an accept that authority rejects', () => {
    const legacyShape = request({
      type: 'MCP',
      payload: { content: null, _meta: { source: 'server' }, availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] },
    });
    expect(hasValidMcpResponsePayload(legacyShape)).toBe(false);
    expect(supportedRequestDecisions(legacyShape)).toEqual(['decline', 'cancel']);
    expect(() => buildPendingRequestResponse(legacyShape, { decision: ['accept'] })).toThrow('not safely available');

    const malformed = request({ type: 'MCP', payload: { server: 'tool-server' } });
    expect(hasValidMcpResponsePayload(malformed)).toBe(false);
    expect(supportedRequestDecisions(malformed)).toEqual(['decline', 'cancel']);
    expect(buildPendingRequestResponse(malformed, { decision: ['decline'] })).toEqual({ type: 'MCP', action: 'decline', content: null, _meta: null });

    const html = renderToStaticMarkup(<PendingRequestSurface language="en-US" request={malformed} onRespond={() => undefined} />);
    expect(html).toContain('Invalid MCP response payload');
    expect(html).toContain('Decline');
    expect(html).toContain('Cancel');
    expect(html).not.toContain('Allow once');
    expect(html).not.toContain('Allow for session');
  });

  it('builds canonical MCP form and URL responses from validated client input', () => {
    const form = request({
      type: 'MCP',
      payload: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'node_repl',
        mode: 'form',
        message: 'Choose a value',
        requestedSchema: {
          type: 'object',
          required: ['choice'],
          properties: { choice: { type: 'string' } },
        },
        _meta: { source: 'server' },
      },
    });
    expect(hasValidMcpResponsePayload(form)).toBe(true);
    expect(supportedRequestDecisions(form)).toEqual(['accept', 'decline', 'cancel']);
    expect(isMcpResponseContentValid(form, '{}')).toBe(false);
    expect(isMcpResponseContentValid(form, '{"choice":"safe"}')).toBe(true);
    expect(buildPendingRequestResponse(form, { decision: ['accept'], mcpContent: ['{"choice":"safe"}'] })).toEqual({
      type: 'MCP',
      action: 'accept',
      content: { choice: 'safe' },
      _meta: null,
    });
    expect(() => buildPendingRequestResponse(form, { decision: ['accept'], mcpContent: ['{}'] })).toThrow('MCP response content is invalid');

    const url = request({
      type: 'MCP',
      payload: { threadId: 'thread-1', turnId: null, serverName: 'oauth', mode: 'url', message: 'Authorize', url: 'https://example.com/authorize?token=QUERY-SECRET-MUST-NOT-RENDER#callback', elicitationId: 'elicitation-1', _meta: null },
    });
    expect(hasValidMcpResponsePayload(url)).toBe(true);
    expect(supportedRequestDecisions(url)).toEqual(['accept', 'decline', 'cancel']);
    expect(buildPendingRequestResponse(url, { decision: ['accept'] })).toEqual({ type: 'MCP', action: 'accept', content: null, _meta: null });
    const html = renderToStaticMarkup(<PendingRequestSurface language="en-US" request={url} onRespond={() => undefined} />);
    expect(html).toContain('Open MCP request page');
    expect(html).toContain('<button type="button" class="session-mcp-url"');
    expect(html).not.toContain('target="_blank"');
    expect(html).not.toContain('QUERY-SECRET-MUST-NOT-RENDER');
    expect(html).toContain('[query hidden]');

    const unsafeUrl = request({ type: 'MCP', payload: { ...canonicalMcpCommon, mode: 'url', message: 'Unsafe', url: 'javascript:alert(1)', elicitationId: 'bad' } });
    expect(hasValidMcpResponsePayload(unsafeUrl)).toBe(false);
    expect(supportedRequestDecisions(unsafeUrl)).toEqual(['decline', 'cancel']);

    const credentialUrl = request({
      type: 'MCP',
      containsSecret: true,
      payload: { ...canonicalMcpCommon, mode: 'url', message: 'Unsafe credentials', url: 'https://user:SECRET-MUST-NOT-RENDER@example.com/authorize', elicitationId: 'credentials' },
    });
    expect(hasValidMcpResponsePayload(credentialUrl)).toBe(false);
    expect(supportedRequestDecisions(credentialUrl)).toEqual(['decline', 'cancel']);
    const credentialHtml = renderToStaticMarkup(<PendingRequestSurface language="en-US" request={credentialUrl} onRespond={() => undefined} />);
    expect(credentialHtml).not.toContain('SECRET-MUST-NOT-RENDER');
    expect(credentialHtml).toContain('[credentials hidden]');

    const unsupportedSchema = request({ type: 'MCP', payload: { ...canonicalMcpCommon, mode: 'openai/form', message: 'Unsupported schema', requestedSchema: { oneOf: [{ type: 'string' }, { type: 'number' }] } } });
    expect(hasValidMcpResponsePayload(unsupportedSchema)).toBe(false);
    expect(supportedRequestDecisions(unsupportedSchema)).toEqual(['decline', 'cancel']);
  });

  it('keeps malformed canonical form schemas fail-closed instead of treating them as openai/form schemas', () => {
    const malformedSchemas = [{}, { type: 'object' }, { type: 'object', properties: {}, required: ['missing'] }, { type: 'string' }];

    for (const requestedSchema of malformedSchemas) {
      const malformedForm = request({
        type: 'MCP',
        payload: { ...canonicalMcpCommon, mode: 'form', message: 'Malformed canonical form', requestedSchema },
      });

      expect(hasValidMcpResponsePayload(malformedForm)).toBe(false);
      expect(supportedRequestDecisions(malformedForm)).toEqual(['decline', 'cancel']);
      expect(isMcpResponseContentValid(malformedForm, '42')).toBe(false);
      expect(() => buildPendingRequestResponse(malformedForm, { decision: ['accept'], mcpContent: ['42'] })).toThrow('The requested decision is not safely available.');

      const html = renderToStaticMarkup(<PendingRequestSurface language="en-US" request={malformedForm} onRespond={() => undefined} />);
      expect(html).toContain('Invalid MCP response payload');
      expect(html).not.toContain('Allow once');
    }

    const openAiForm = request({
      type: 'MCP',
      payload: { ...canonicalMcpCommon, mode: 'openai/form', message: 'Generic JSON value', requestedSchema: {} },
    });
    expect(hasValidMcpResponsePayload(openAiForm)).toBe(true);
    expect(isMcpResponseContentValid(openAiForm, '42')).toBe(true);
  });

  it('matches openai/form object enum values by deep JSON equality independent of object key order', () => {
    const form = request({
      type: 'MCP',
      payload: {
        ...canonicalMcpCommon,
        mode: 'openai/form',
        message: 'Choose the canonical object',
        requestedSchema: {
          type: 'object',
          required: ['choice'],
          properties: {
            choice: { enum: [{ a: 1, b: 2, order: [1, 2] }] },
          },
        },
      },
    });

    expect(isMcpResponseContentValid(form, '{"choice":{"order":[1,2],"b":2,"a":1}}')).toBe(true);
    expect(isMcpResponseContentValid(form, '{"choice":{"order":[2,1],"b":2,"a":1}}')).toBe(false);
  });

  it('requires the complete canonical MCP envelope before exposing Allow', () => {
    const schema = { type: 'object', properties: {} };
    const incompletePayloads = [
      { turnId: 'turn-1', serverName: 'node_repl', mode: 'form', message: 'Missing thread', requestedSchema: schema, _meta: null },
      { threadId: 'thread-1', serverName: 'node_repl', mode: 'form', message: 'Missing turn', requestedSchema: schema, _meta: null },
      { threadId: 'thread-1', turnId: 'turn-1', mode: 'form', message: 'Missing server', requestedSchema: schema, _meta: null },
      { threadId: 'thread-1', turnId: 'turn-1', serverName: 'node_repl', mode: 'form', message: 'Missing meta', requestedSchema: schema },
      { ...canonicalMcpCommon, mode: 'form', message: 'Unexpected field', requestedSchema: schema, unexpected: true },
    ];

    for (const payload of incompletePayloads) {
      const incomplete = request({ type: 'MCP', payload });
      expect(hasValidMcpResponsePayload(incomplete)).toBe(false);
      expect(supportedRequestDecisions(incomplete)).toEqual(['decline', 'cancel']);
    }
  });

  it('validates canonical form primitive constraints and rejects ambiguous schemas', () => {
    const constrainedForm = request({
      type: 'MCP',
      payload: {
        ...canonicalMcpCommon,
        mode: 'form',
        message: 'Complete the constrained form',
        requestedSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 4 },
            count: { type: 'integer', minimum: 1, maximum: 3 },
            choice: { type: 'string', enum: ['safe', 'review'] },
            tags: {
              type: 'array',
              minItems: 1,
              maxItems: 2,
              items: { type: 'string', enum: ['frontend', 'backend', 'test'] },
            },
          },
          required: ['name', 'count', 'choice', 'tags'],
        },
      },
    });

    expect(hasValidMcpResponsePayload(constrainedForm)).toBe(true);
    expect(isMcpResponseContentValid(constrainedForm, '{"name":"Zeus","count":2,"choice":"safe","tags":["frontend"]}')).toBe(true);
    expect(isMcpResponseContentValid(constrainedForm, '{"name":"Z","count":2,"choice":"safe","tags":["frontend"]}')).toBe(false);
    expect(isMcpResponseContentValid(constrainedForm, '{"name":"Zeus","count":1.5,"choice":"safe","tags":["frontend"]}')).toBe(false);
    expect(isMcpResponseContentValid(constrainedForm, '{"name":"Zeus","count":2,"choice":"other","tags":["frontend"]}')).toBe(false);
    expect(isMcpResponseContentValid(constrainedForm, '{"name":"Zeus","count":2,"choice":"safe","tags":["frontend","backend","test"]}')).toBe(false);

    const ambiguousForm = request({
      type: 'MCP',
      payload: {
        ...canonicalMcpCommon,
        mode: 'form',
        message: 'Ambiguous enum',
        requestedSchema: {
          type: 'object',
          properties: {
            choice: {
              type: 'string',
              enum: ['safe'],
              oneOf: [{ const: 'safe', title: 'Safe' }],
            },
          },
        },
      },
    });
    expect(hasValidMcpResponsePayload(ambiguousForm)).toBe(false);
    expect(supportedRequestDecisions(ambiguousForm)).toEqual(['decline', 'cancel']);
  });

  it('validates canonical date-time values as strict RFC3339 timestamps', () => {
    const dateTimeForm = request({
      type: 'MCP',
      payload: {
        ...canonicalMcpCommon,
        mode: 'form',
        message: 'Choose a timestamp',
        requestedSchema: {
          type: 'object',
          properties: { when: { type: 'string', format: 'date-time' } },
          required: ['when'],
        },
      },
    });

    expect(hasValidMcpResponsePayload(dateTimeForm)).toBe(true);
    expect(isMcpResponseContentValid(dateTimeForm, '{"when":"2026-02-28T12:00:00Z"}')).toBe(true);
    expect(isMcpResponseContentValid(dateTimeForm, '{"when":"2026-02-28T12:00:00+08:00"}')).toBe(true);
    expect(isMcpResponseContentValid(dateTimeForm, '{"when":"2026-02-30T12:00:00Z"}')).toBe(false);
    expect(isMcpResponseContentValid(dateTimeForm, '{"when":"2026-02-28T12:00:00"}')).toBe(false);
    expect(isMcpResponseContentValid(dateTimeForm, '{"when":"2026-02-28T24:00:00Z"}')).toBe(false);
  });

  it('renders a safe no-grant permissions decision instead of an unusable empty action rail', () => {
    const malformed = request({ type: 'permissions', payload: { permissions: { unexpected: true } } });
    expect(supportedRequestDecisions(malformed)).toEqual(['decline']);
    expect(buildPendingRequestResponse(malformed, { decision: ['decline'] })).toEqual({ type: 'permissions', permissions: {}, scope: 'turn' });

    const html = renderToStaticMarkup(<PendingRequestSurface language="en-US" request={malformed} onRespond={() => undefined} />);
    expect(html).toContain('Decline');
    expect(html).not.toContain('Allow once');
    expect(html).not.toContain('Allow for session');
  });

  it('chooses a fail-closed approval action for default autofocus and never chooses Allow', () => {
    expect(defaultAutofocusDecision(['accept', 'decline', 'cancel'])).toBe('decline');
    expect(defaultAutofocusDecision(['accept', 'acceptForSession'])).toBeNull();
  });

  it('renders a secret Other answer as a masked input without echoing provider secret data', () => {
    const secret = 'SECRET-OTHER-MUST-NOT-RENDER';
    const html = renderToStaticMarkup(
      <PendingRequestSurface
        language="en-US"
        request={request({
          type: 'userInput',
          containsSecret: true,
          payload: canonicalRuiPayload([
            {
              id: 'token',
              header: 'Token',
              question: 'Choose or enter a token',
              options: [{ label: 'Use stored token', description: '' }],
              isOther: true,
              isSecret: true,
              providerSecret: secret,
            },
          ]),
        })}
        onRespond={() => undefined}
      />,
    );

    expect(html).toMatch(/<input[^>]*aria-label="Other: Token"[^>]*type="password"[^>]*autocomplete="off"/i);
    expect(html).not.toContain(secret);
  });

  it('uses password-manager-safe attributes for every secret answer input, including Other', () => {
    expect(answerInputSecurityAttributes(true)).toEqual({ type: 'password', autoComplete: 'off' });
    expect(answerInputSecurityAttributes(false)).toEqual({ type: 'text' });
  });

  it('accepts only complete canonical RUI questions and fails the whole request closed on malformed or duplicate questions', () => {
    const canonicalQuestions = [
      {
        id: 'single',
        header: 'Single',
        question: 'Choose one',
        options: [
          { label: 'A', description: 'First' },
          { label: 'B', description: 'Second' },
        ],
        isOther: false,
        isSecret: false,
      },
      {
        id: 'multiple',
        header: 'Multiple',
        question: 'Choose several',
        options: [
          { label: 'X', description: 'First' },
          { label: 'Y', description: 'Second' },
        ],
        isOther: true,
        isSecret: false,
        multiple: true,
      },
      { id: 'notes', header: 'Notes', question: 'Explain', options: null, isOther: false, isSecret: true },
    ];
    const canonical = request({ type: 'userInput', payload: canonicalRuiPayload(canonicalQuestions) });
    expect(normalizeRequestQuestions(canonical)).toEqual([
      expect.objectContaining({ id: 'single', kind: 'single', allowOther: false }),
      expect.objectContaining({ id: 'multiple', kind: 'multiple', allowOther: true }),
      expect.objectContaining({ id: 'notes', kind: 'freeform', secret: true }),
    ]);

    const malformedQuestionSets = [
      [],
      [canonicalQuestions[0], { ...canonicalQuestions[0] }],
      [{ ...canonicalQuestions[0], id: '' }],
      [{ id: 'missing-fields', header: 'Missing', question: 'Missing canonical fields' }],
      [{ ...canonicalQuestions[0], options: ['A', 'B'] }],
      [
        {
          ...canonicalQuestions[0],
          options: [
            { label: 'A', description: '' },
            { label: 'A', description: 'duplicate' },
          ],
        },
      ],
      [{ ...canonicalQuestions[0], isSecret: 'false' }],
    ];
    for (const questions of malformedQuestionSets) {
      const malformed = request({ type: 'userInput', payload: canonicalRuiPayload(questions) });
      expect(normalizeRequestQuestions(malformed)).toEqual([]);
      const html = renderToStaticMarkup(<PendingRequestSurface language="en-US" request={malformed} onRespond={() => undefined} />);
      expect(html).not.toContain('Submit answers');
    }

    const malformedEnvelopes = [
      { turnId: 'turn-1', itemId: 'rui-item-1', questions: canonicalQuestions, autoResolutionMs: null },
      canonicalRuiPayload(canonicalQuestions, { autoResolutionMs: -1 }),
      canonicalRuiPayload(canonicalQuestions, { unexpected: true }),
    ];
    for (const payload of malformedEnvelopes) {
      const malformed = request({ type: 'userInput', payload });
      expect(normalizeRequestQuestions(malformed)).toEqual([]);
      expect(() => buildPendingRequestResponse(malformed, { single: ['A'], multiple: ['X'], notes: ['ok'] })).toThrow('complete canonical question set');
    }
  });

  it('builds only exact complete RUI answers and rejects missing, arbitrary, and overreaching values', () => {
    const rui = request({
      type: 'userInput',
      payload: canonicalRuiPayload([
        {
          id: 'single',
          header: 'Single',
          question: 'Choose one',
          options: [
            { label: 'A', description: '' },
            { label: 'B', description: '' },
          ],
          isOther: false,
          isSecret: false,
        },
        {
          id: 'multiple',
          header: 'Multiple',
          question: 'Choose several',
          options: [
            { label: 'X', description: '' },
            { label: 'Y', description: '' },
          ],
          isOther: true,
          isSecret: false,
          multiple: true,
        },
        { id: 'notes', header: 'Notes', question: 'Explain', options: null, isOther: false, isSecret: true },
      ]),
    });
    const questions = normalizeRequestQuestions(rui);
    const validAnswers = { single: ['A'], multiple: ['X', '__other__'], notes: ['private note'] };
    expect(areRequiredRequestAnswersComplete(questions, validAnswers, { multiple: 'Custom' })).toBe(true);
    expect(buildPendingRequestResponse(rui, validAnswers, { multiple: 'Custom' })).toEqual({
      type: 'userInput',
      answers: {
        single: { answers: ['A'] },
        multiple: { answers: ['X', 'Custom'] },
        notes: { answers: ['private note'] },
      },
    });

    expect(() => buildPendingRequestResponse(rui, { single: ['A'], multiple: ['X'] })).toThrow('complete canonical question set');
    expect(() => buildPendingRequestResponse(rui, { single: ['A'], multiple: ['X'], notes: ['ok'], invented: ['value'] })).toThrow('exactly match');
    expect(() => buildPendingRequestResponse(rui, { single: ['A', 'B'], multiple: ['X'], notes: ['ok'] })).toThrow('single answer');
    expect(() => buildPendingRequestResponse(rui, { single: ['invented'], multiple: ['X'], notes: ['ok'] })).toThrow('advertised option');
    expect(() => buildPendingRequestResponse(rui, { single: ['A'], multiple: ['invented-1', 'invented-2'], notes: ['ok'] })).toThrow('Other answer');
  });

  it('keeps an advertised __other__ option distinct from the generated Other control value', () => {
    for (const isOther of [false, true]) {
      const rui = request({
        type: 'userInput',
        payload: canonicalRuiPayload([
          {
            id: `sentinel-${String(isOther)}`,
            header: 'Sentinel collision',
            question: 'Choose the advertised label',
            options: [{ label: '__other__', description: 'A provider-owned option label' }],
            isOther,
            isSecret: false,
          },
        ]),
      });
      const questionId = `sentinel-${String(isOther)}`;
      const questions = normalizeRequestQuestions(rui);
      const advertisedAnswer = { [questionId]: ['__other__'] };

      expect(areRequiredRequestAnswersComplete(questions, advertisedAnswer)).toBe(true);
      expect(buildPendingRequestResponse(rui, advertisedAnswer)).toEqual({
        type: 'userInput',
        answers: { [questionId]: { answers: ['__other__'] } },
      });

      if (isOther) {
        const html = renderToStaticMarkup(<PendingRequestSurface language="en-US" request={rui} onRespond={() => undefined} />);
        expect(html.match(/value="__other__"/gu)).toHaveLength(1);
      }
    }
  });
});
