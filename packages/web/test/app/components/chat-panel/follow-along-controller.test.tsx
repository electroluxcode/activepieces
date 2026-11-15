// @vitest-environment jsdom
import {
  FlowDraftUpdatedEvent,
  ResourceChangeOp,
  WebsocketClientEvent,
} from '@activepieces/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FollowAlongController } from '@/app/components/chat-panel/follow-along-controller';
import {
  followAlong,
  useFollowAlong,
} from '@/features/chat/lib/follow/follow-along';
import { followHold } from '@/features/chat/lib/follow/follow-hold';
import { useChatPanel } from '@/features/workspace/lib/chat-panel-open';
import { authenticationSession } from '@/lib/authentication-session';

const socketHarness = vi.hoisted(() => {
  const handlers: Record<string, ((payload: unknown) => void)[]> = {};
  return {
    socket: {
      on: (event: string, handler: (payload: unknown) => void) => {
        handlers[event] = [...(handlers[event] ?? []), handler];
      },
      off: (event: string, handler: (payload: unknown) => void) => {
        handlers[event] = (handlers[event] ?? []).filter((h) => h !== handler);
      },
    },
    send: (event: string, payload: unknown) =>
      (handlers[event] ?? []).forEach((handler) => handler(payload)),
  };
});

const flowNames = vi.hoisted(() => {
  const pending = new Map<string, (name: string) => void>();
  return {
    pending,
    resolve: (flowId: string, name: string) => pending.get(flowId)?.(name),
  };
});

vi.mock('i18next', () => ({ t: (key: string) => key }));
vi.mock('@/components/providers/socket-provider', () => ({
  useSocket: () => socketHarness.socket,
}));
vi.mock('@/features/flows/api/flows-api', () => ({
  flowsApi: {
    get: (flowId: string) =>
      new Promise((resolve) => {
        flowNames.pending.set(flowId, (name) =>
          resolve({ version: { displayName: name } }),
        );
      }),
  },
}));

const run = {
  conversationId: 'chat-1',
  runId: 'run-1',
  attach: 'sent' as const,
};

function push(op: ResourceChangeOp, flowId = 'flow-a') {
  const event: FlowDraftUpdatedEvent = {
    flowId,
    editorSessionId: 'chat-1',
    op,
  };
  act(() => socketHarness.send(WebsocketClientEvent.FLOW_DRAFT_UPDATED, event));
}

async function resolveName(flowId: string, name: string) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flowNames.resolve(flowId, name);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('FollowAlongController', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.spyOn(authenticationSession, 'getProjectId').mockReturnValue('p1');
    vi.spyOn(authenticationSession, 'getCurrentUserId').mockReturnValue('u1');
    vi.spyOn(authenticationSession, 'getPlatformId').mockReturnValue('pl1');
    followAlong.reset();
    useChatPanel.setState({ conversationId: 'chat-1', autoFollow: false });
    queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/projects/p1/automations']}>
          <FollowAlongController />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    followAlong.startRun(run);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('refreshes the lists as soon as the chat push arrives', () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    push(ResourceChangeOp.UPDATE);

    expect(invalidate).toHaveBeenCalled();
  });

  it('keeps a deleted flow closed when an earlier name lookup finishes late', async () => {
    push(ResourceChangeOp.UPDATE);
    push(ResourceChangeOp.DELETE);

    await resolveName('flow-a', 'Flow A');

    expect(useFollowAlong.getState()).toMatchObject({
      target: null,
      offer: null,
    });
  });

  it('keeps the page held until the click after a press has run', () => {
    vi.useFakeTimers();
    fireEvent.pointerDown(document.body);
    fireEvent.pointerUp(document.body);

    expect(followHold.pagePressed()).toBe(true);
    act(() => vi.runAllTimers());
    expect(followHold.pagePressed()).toBe(false);
    vi.useRealTimers();
  });

  it('follows the newest flow when an earlier lookup finishes last', async () => {
    push(ResourceChangeOp.UPDATE, 'flow-a');
    push(ResourceChangeOp.UPDATE, 'flow-b');

    await resolveName('flow-b', 'Flow B');
    await resolveName('flow-a', 'Flow A');
    await resolveName('flow-b', 'Flow B');

    expect(useFollowAlong.getState().target?.id).toBe('flow-b');
  });

  it('keeps following when another tab only changes a saved preference', () => {
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'theme' }));
    });

    expect(followAlong.runOf('chat-1')).toEqual(run);
  });
});
