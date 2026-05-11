import type { CartLineItem } from "./repository/index.js";

/**
 * Determines whether a new item matches an existing cart line item.
 * Used by addItem to decide whether to increment quantity (match)
 * or insert a new line (no match).
 *
 * The default matcher compares entityId + variantId.
 * Developers selling customizable products (engraving, gift notes)
 * can provide a custom matcher that includes metadata fields.
 */
export type CartItemMatcher = (args: {
  existingItem: CartLineItem;
  newItem: {
    entityId: string;
    variantId: string | null;
    [key: string]: unknown;
  };
}) => boolean;

export const defaultCartItemMatcher: CartItemMatcher = ({
  existingItem,
  newItem,
}) =>
  existingItem.entityId === newItem.entityId &&
  existingItem.variantId === (newItem.variantId ?? null);
