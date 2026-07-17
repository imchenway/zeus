import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PendingRequestSurface } from '../src/renderer/session/PendingRequestSurface.js';
import type { NativePendingRequest } from '../src/renderer/session/sessionTypes.js';

describe('MCP external URL surface', () => {
  it('uses the audited Main bridge trigger instead of a denied target-blank link', () => {
    const request: NativePendingRequest = {
      id: 'mcp-url-request',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      itemId: null,
      generationId: 'generation-1',
      type: 'MCP',
      status: 'pending',
      payload: {
        mode: 'url',
        message: 'Authorize the MCP server',
        url: 'https://example.com/authorize',
        elicitationId: 'elicitation-1',
        _meta: null,
      },
      response: null,
      containsSecret: false,
      expiresAt: null,
      createdAt: '2026-07-13T00:00:00.000Z',
      resolvedAt: null,
    };

    const html = renderToStaticMarkup(<PendingRequestSurface language="en-US" request={request} onRespond={() => undefined} />);

    expect(html).toContain('<button type="button" class="session-mcp-url"');
    expect(html).toContain('Open MCP request page');
    expect(html).not.toContain('target="_blank"');
    expect(html).not.toContain('href="https://example.com/authorize"');
  });
});
