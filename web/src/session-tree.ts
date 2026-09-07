/** Pi-style session threading for the workspace sidebar. @author coolonion */
import type { SessionSummary } from './types';

export interface SessionTreeNode {
  session: SessionSummary;
  children: SessionTreeNode[];
  latestActivity: number;
}

/** Parent metadata defines ancestry; titles never change a session's place. */
export function buildSessionTree(sessions: SessionSummary[]): SessionTreeNode[] {
  const byPath = new Map(sessions.map((session) => [session.path, {
    session,
    children: [] as SessionTreeNode[],
    latestActivity: Date.parse(session.modified),
  }]));
  const roots: SessionTreeNode[] = [];
  for (const node of byPath.values()) {
    const parent = node.session.parentSessionPath
      ? byPath.get(node.session.parentSessionPath)
      : undefined;
    // A missing parent (deleted, archived, or outside this project) is a root.
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sortSubtree = (node: SessionTreeNode): number => {
    for (const child of node.children) {
      node.latestActivity = Math.max(node.latestActivity, sortSubtree(child));
    }
    node.children.sort((a, b) => b.latestActivity - a.latestActivity);
    return node.latestActivity;
  };
  for (const root of roots) sortSubtree(root);
  return roots.sort((a, b) => b.latestActivity - a.latestActivity);
}
