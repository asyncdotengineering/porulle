/**
 * Analytics hooks — legacy compatibility surface.
 *
 * The in-memory event recording hooks (recordOrderAnalyticsEvent,
 * recordInventoryAnalyticsEvent) have been removed. The source tables
 * (orders, inventory_levels, customers) ARE the source of truth; the
 * DrizzleAnalyticsAdapter queries them directly via SQL.
 *
 * The empty exports below preserve backwards compatibility for code
 * still importing from this module.
 */
