// Pure helpers the content editor uses to change its copy of a section. Each returns a new value
// and leaves the original alone, so everything the form doesn't show is carried over untouched.

export type Path = readonly (string | number)[];

/** "0.startTime" or "hotel.coords.lat": a path written the way the store's messages name fields. */
export function pathKey(path: Path): string {
  return path.join(".");
}

export function getAt(root: unknown, path: Path): unknown {
  let current = root;
  for (const step of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[step];
  }
  return current;
}

export function setAt(root: unknown, path: Path, value: unknown): unknown {
  if (path.length === 0) return value;
  const [step, ...rest] = path;
  if (Array.isArray(root) && typeof step === "number") {
    const copy = [...root];
    copy[step] = setAt(root[step], rest, value);
    return copy;
  }
  const record = typeof root === "object" && root !== null ? (root as Record<string, unknown>) : {};
  return { ...record, [step]: setAt(record[step], rest, value) };
}

export function insertAt<TItem>(list: readonly TItem[], index: number, item: TItem): TItem[] {
  return [...list.slice(0, index), item, ...list.slice(index)];
}

export function removeAt<TItem>(list: readonly TItem[], index: number): TItem[] {
  return list.filter((_item, position) => position !== index);
}

/** Moves one item to another place; a move off either end changes nothing. */
export function moveItem<TItem>(list: readonly TItem[], from: number, to: number): TItem[] {
  if (to < 0 || to >= list.length || from === to) return [...list];
  return insertAt(removeAt(list, from), to, list[from]);
}

/**
 * The next item up (`step` -1) or down (1) among `indexes`, the items of one group in list order;
 * undefined at the group's edge.
 */
export function groupNeighbour(indexes: readonly number[], index: number, step: -1 | 1): number | undefined {
  const position = indexes.indexOf(index);
  return position < 0 ? undefined : indexes[position + step];
}

/** Moves an item past its neighbour in its group; at the group's edge, nothing changes. */
export function moveWithinGroup<TItem>(list: readonly TItem[], indexes: readonly number[], index: number, step: -1 | 1): TItem[] {
  const neighbour = groupNeighbour(indexes, index, step);
  return neighbour === undefined ? [...list] : moveItem(list, index, neighbour);
}
