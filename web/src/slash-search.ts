/** Rank slash-command suggestions without changing the command sent to Pi. @author coolonion */
export interface SlashSearchItem {
  cmd: string;
  desc: string;
}

function isSubsequence(value: string, query: string): boolean {
  let matched = 0;
  for (const char of value) {
    if (char === query[matched]) matched += 1;
    if (matched === query.length) return true;
  }
  return false;
}

function matchRank(command: string, query: string): number | undefined {
  if (!query) return 0;
  const name = command.replace(/^\//, '').toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  // The namespace is not part of fuzzy matching: "skill:" must not make
  // unrelated skills look like a match for a short bare skill name.
  const searchable = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
  if (searchable.startsWith(query)) return 2;
  const segments = searchable.split(/[-_/]+/);
  if (segments.some((segment) => segment.startsWith(query))) return 3;
  if (searchable.includes(query)) return 4;
  if (segments.some((segment) => isSubsequence(segment, query))) return 5;
  return undefined;
}

export function searchSlashCommands<T extends SlashSearchItem>(items: T[], query: string): T[] {
  const normalized = query.toLowerCase();
  return items
    .map((item, index) => ({ item, index, rank: matchRank(item.cmd, normalized) }))
    .filter((result): result is typeof result & { rank: number } => result.rank !== undefined)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item);
}
