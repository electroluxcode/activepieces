import { ApResourceKind, isNil } from '@activepieces/core-utils';
import {
  FlowDraftUpdatedEvent,
  ResourceChangeOp,
  TableUpdatedEvent,
  WebsocketClientEvent,
} from '@activepieces/shared';
import { useQueryClient } from '@tanstack/react-query';
import { t } from 'i18next';
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { useEmbedding } from '@/components/providers/embed-provider';
import { useSocket } from '@/components/providers/socket-provider';
import {
  FollowChange,
  RunContext,
  followAlong,
  useFollowAlong,
} from '@/features/chat/lib/follow/follow-along';
import { resourceRegistry } from '@/features/chat/lib/resources/registry';
import {
  chatPanelUtils,
  useChatPanel,
} from '@/features/workspace/lib/chat-panel-open';
import { authenticationSession } from '@/lib/authentication-session';

export function FollowAlongController() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const queryClient = useQueryClient();
  const socket = useSocket();
  const embedded = useEmbedding().embedState.isEmbedded;
  const targetKey = useFollowAlong((s) =>
    s.target ? resourceRegistry.keyOf(s.target) : null,
  );
  const following = useFollowAlong((s) => s.following);
  const phase = useFollowAlong((s) => s.phase);
  const autoFollow = useChatPanel((s) => s.autoFollow);
  const lastPath = useRef(pathname);
  const selfNavRef = useRef<string | null>(null);
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const runOfTarget = useRef<string | null>(null);

  useEffect(() => {
    let owner = sessionOwner();
    return authenticationSession.subscribe(() => {
      const next = sessionOwner();
      if (next === owner) return;
      owner = next;
      followAlong.reset();
    });
  }, []);

  useEffect(() => {
    let inOrder: Promise<void> = Promise.resolve();
    const follow = ({ kind, id, op, editorSessionId }: ServerChange) => {
      const run = followAlong.runOf(editorSessionId);
      const projectId = authenticationSession.getProjectId();
      if (isNil(run) || isNil(projectId)) return;
      resourceRegistry
        .queryKeys({ ref: { kind, id }, op })
        .forEach((queryKey) =>
          queryClient.invalidateQueries({ queryKey }).catch(() => undefined),
        );
      inOrder = inOrder
        .then(() => followChange({ kind, id, op, run, projectId }))
        .catch(() => undefined);
    };
    const followChange = async ({
      kind,
      id,
      op,
      run,
      projectId,
    }: Omit<ServerChange, 'editorSessionId'> & {
      run: RunContext;
      projectId: string;
    }) => {
      const name =
        op === ResourceChangeOp.DELETE
          ? followAlong.knownName({ kind, id }) ?? ''
          : await queryClient.fetchQuery({
              queryKey: ['follow-along-name', kind, id],
              queryFn: () => resourceRegistry.fetchName({ kind, id }),
              staleTime: NAME_STALE_MS,
            });
      followAlong.onServerChange({
        resource: { kind, id, projectId, name },
        op,
        run,
      });
    };
    const onFlow = (event: FlowDraftUpdatedEvent) =>
      follow({ kind: ApResourceKind.FLOW, id: event.flowId, ...event });
    const onTable = (event: TableUpdatedEvent) =>
      follow({ kind: ApResourceKind.TABLE, id: event.tableId, ...event });
    socket.on(WebsocketClientEvent.FLOW_DRAFT_UPDATED, onFlow);
    socket.on(WebsocketClientEvent.TABLE_UPDATED, onTable);
    return () => {
      socket.off(WebsocketClientEvent.FLOW_DRAFT_UPDATED, onFlow);
      socket.off(WebsocketClientEvent.TABLE_UPDATED, onTable);
    };
  }, [socket, queryClient]);

  useEffect(() => {
    const leaveIfDeleted = (change: FollowChange) => {
      const deletedByThisChat =
        change.op === ResourceChangeOp.DELETE && change.navigable && !embedded;
      if (!deletedByThisChat) return;
      const isOnDeletedPage = () =>
        resourceRegistry.isOn({
          pathname: pathnameRef.current,
          ref: change.resource,
        });
      if (!isOnDeletedPage()) return;
      if (change.resource.name) {
        toast(t('The AI deleted {name}.', { name: change.resource.name }));
      }
      const route = resourceRegistry.parentRoute(change.resource);
      selfNavRef.current = route;
      navigate(route, { replace: true });
    };
    const stopListening = followAlong.onToolDone((change) => {
      leaveIfDeleted(change);
      if (change.navigable && change.op !== ResourceChangeOp.DELETE) {
        runOfTarget.current = change.runId;
      }
    });
    return stopListening;
  }, [navigate, embedded]);

  useEffect(() => {
    const state = useFollowAlong.getState();
    const pathChanged = lastPath.current !== pathname;
    lastPath.current = pathname;
    const selfNavigated = selfNavRef.current === pathname;
    if (pathChanged) selfNavRef.current = null;
    const target = state.target;
    if (!target || !state.following) return;
    const onTarget = resourceRegistry.isOn({ pathname, ref: target });
    if (pathChanged && !selfNavigated && !onTarget) {
      if (state.phase === 'editing') followAlong.stopFollowing();
      return;
    }
    if (
      onTarget ||
      state.phase !== 'editing' ||
      embedded ||
      !autoFollow ||
      !resourceRegistry.isInCurrentProject(target)
    ) {
      return;
    }

    const route = resourceRegistry.route(target);
    const push = followAlong.claimHistoryPush(runOfTarget.current);
    selfNavRef.current = route.split('?')[0];
    chatPanelUtils.openBeside({ route, push, name: target.name });
  }, [pathname, targetKey, following, phase, embedded, autoFollow]);

  return null;
}

function sessionOwner(): string {
  return `${authenticationSession.getPlatformId()}:${authenticationSession.getCurrentUserId()}`;
}

const NAME_STALE_MS = 2000;

type ServerChange = {
  kind: ApResourceKind;
  id: string;
  op: ResourceChangeOp;
  editorSessionId: string | null;
};
