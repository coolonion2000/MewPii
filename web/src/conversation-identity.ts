/** Conversation ownership across route canonicalization. @author coolonion */
import type { SelectionState } from "./state-utils";

interface ConversationIdentity {
  cwd: string;
  agent: string | undefined;
  snapshot?: { sessionFile?: string; sessionId?: string };
}

export interface ConversationBinding<T extends ConversationIdentity> {
  selection: SelectionState | undefined;
  agent: string | undefined;
  conversation: T | undefined;
}

function sameSelection(
  a: SelectionState | undefined,
  b: SelectionState | undefined,
): boolean {
  return a?.cwd === b?.cwd &&
    a?.sessionPath === b?.sessionPath &&
    a?.sessionId === b?.sessionId;
}

export function reconcileConversationBinding<T extends ConversationIdentity>(
  current: ConversationBinding<T> | undefined,
  selection: SelectionState | undefined,
  agent: string | undefined,
  create: (selection: SelectionState, agent: string | undefined) => T,
): ConversationBinding<T> {
  const conversation = current?.conversation;
  const snapshot = conversation?.snapshot;
  // An unchanged route may briefly lag a /new snapshot. Keep its owner until
  // canonicalization, but do not swallow an explicit selection of that old
  // session (a new selection object) during the same interval.
  if (current && current.agent === agent &&
    (current.selection === selection || (!snapshot && sameSelection(current.selection, selection))))
    return current;
  // Only the current host's identity is an alias. In particular, an old path
  // after /new, a blank selection, and another agent must create a new owner.
  const followsHost = conversation &&
    conversation.agent === agent &&
    selection?.cwd === conversation.cwd &&
    (selection.sessionPath
      ? selection.sessionPath === snapshot?.sessionFile &&
        (!selection.sessionId || selection.sessionId === snapshot?.sessionId)
      : Boolean(selection.sessionId && selection.sessionId === snapshot?.sessionId));
  return {
    selection,
    agent,
    conversation: followsHost
      ? conversation
      : selection?.cwd ? create(selection, agent) : undefined,
  };
}
