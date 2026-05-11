import { pgSequence } from "drizzle-orm/pg-core";

export const orderNumberSeq = pgSequence("order_number_seq", {
  startWith: 1,
  increment: 1,
});
