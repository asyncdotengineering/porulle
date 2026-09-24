/**
 * THE deletion policy for a store's mapped products that a fetch no longer lists — one home for
 * the rule, shared by `reconcile()` and the app's import finalize barrier.
 *
 * A fetch that succeeded is not a fetch that was complete: a merchant API hiccup, pagination that
 * stopped early, or an auth scope change returns fewer products than the store has, and archiving
 * "everything absent" then wipes the store. Found on the sim, 2026-09-24. So the plan REFUSES:
 *  - an empty fetch over a store that has mapped products;
 *  - more absent products than max(ABSENT_ARCHIVE_FLOOR, floor(ABSENT_ARCHIVE_FRACTION × mapped)).
 * A refusal archives nothing; the caller surfaces the reason for a person to look at.
 */
export const ABSENT_ARCHIVE_FLOOR = 5;
export const ABSENT_ARCHIVE_FRACTION = 0.2;

export type AbsentArchivePlan = { archive: string[] } | { refused: string };

export function planAbsentArchives(mappedExternalIds: Iterable<string>, presentExternalIds: Iterable<string>): AbsentArchivePlan {
  const mapped = [...new Set(mappedExternalIds)];
  const present = new Set(presentExternalIds);
  const absent = mapped.filter((externalId) => !present.has(externalId));
  if (absent.length === 0) return { archive: [] };
  if (present.size === 0) {
    return { refused: `The fetch listed no products while ${mapped.length} are mapped; refusing to archive them.` };
  }
  const bound = Math.max(ABSENT_ARCHIVE_FLOOR, Math.floor(ABSENT_ARCHIVE_FRACTION * mapped.length));
  if (absent.length > bound) {
    return { refused: `${absent.length} of ${mapped.length} mapped products are absent from the fetch, above the bound of ${bound}; refusing to archive them.` };
  }
  return { archive: absent };
}
