// Budgeted walk over a paged Graph collection with exact resume.
//
// A tick can run out of budget part-way through a page. The position — the
// page's URL, how many of its items are handled and the id of the last one —
// is persisted after every item, so the next tick (or the tick after a
// throttle pause or an eviction) resumes at the next unhandled item instead of
// moving on to the next page and silently skipping the rest of this one.

import type { MigrationContext } from './workload';

interface PagePosition {
  /** URL of the page being worked through. */
  url: string;
  /** How many of that page's items are handled. */
  index: number;
  /** Id of the last handled item — re-anchors `index` if the page shifted. */
  lastId?: string;
}

export interface PagedCollection {
  /** Unique within the workload; namespaces the persisted position. */
  key: string;
  /** URL of the collection's first page. */
  firstUrl: string;
  pageSize: number;
}

/**
 * Where to resume on a re-fetched page. Normally `index`; if items before it
 * were added or removed since the page was last read, re-anchor on the last
 * handled item, and if that item is gone, start the page over — the id map
 * turns already-copied items into skips, so nothing is copied twice.
 */
export function resumeIndex(items: { id: string }[], pos: { index: number; lastId?: string }): number {
  if (pos.index === 0 || !pos.lastId) return pos.index;
  if (items[pos.index - 1]?.id === pos.lastId) return pos.index;
  const at = items.findIndex((item) => item.id === pos.lastId);
  return at >= 0 ? at + 1 : 0;
}

/**
 * Hand each item of a paged collection to `handle`, within the tick budget.
 * Returns true once the whole collection has been handled, false when the
 * budget ran out first (call again on the next tick to continue).
 */
export async function drainPages<T extends { id: string }>(
  ctx: MigrationContext,
  workload: string,
  collection: PagedCollection,
  handle: (item: T) => Promise<void>
): Promise<boolean> {
  const { store, budget } = ctx;
  const posKey = `page:${collection.key}`;
  while (!budget.exhausted) {
    const pos = store.getState<PagePosition>(workload, posKey) ?? { url: collection.firstUrl, index: 0 };
    const page = await ctx.source.page<T>(pos.url, collection.pageSize);
    for (let i = resumeIndex(page.items, pos); i < page.items.length; i++) {
      if (budget.exhausted) return false;
      const item = page.items[i]!;
      await handle(item);
      store.setState(workload, posKey, { url: pos.url, index: i + 1, lastId: item.id } satisfies PagePosition);
    }
    if (!page.nextLink) {
      store.delState(workload, posKey);
      return true;
    }
    store.setState(workload, posKey, { url: page.nextLink, index: 0 } satisfies PagePosition);
  }
  return false;
}
