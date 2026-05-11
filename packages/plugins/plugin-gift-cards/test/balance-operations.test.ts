import { TEST_ORG_ID } from "@porulle/core/testing";
import { describe, it, expect } from "vitest";
import { GiftCardService } from "../src/services/gift-card-service.js";
import type { Db, GiftCardPluginOptions } from "../src/types.js";
import { DEFAULT_OPTIONS } from "../src/types.js";

const ORG = TEST_ORG_ID;

function createMockService(overrides?: Partial<GiftCardPluginOptions>) {
  const mockDb = {} as Db;
  const mockTx = async (fn: (tx: Db) => Promise<unknown>) => fn(mockDb);
  return new GiftCardService(
    mockDb,
    mockTx,
    { ...DEFAULT_OPTIONS, defaultExpiryDays: null, ...overrides } as Required<GiftCardPluginOptions>,
  );
}

describe("GiftCardService", () => {
  describe("debitWithLock", () => {
    it("should reject negative debit amounts", async () => {
      const service = createMockService();
      const result = await service.debitWithLock(ORG, "TEST", -100, "order-1", "EUR");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Debit amount must be positive");
      }
    });

    it("should reject zero debit amounts", async () => {
      const service = createMockService();
      const result = await service.debitWithLock(ORG, "TEST", 0, "order-1", "EUR");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Debit amount must be positive");
      }
    });
  });

  describe("creditWithLock", () => {
    it("should reject negative credit amounts", async () => {
      const service = createMockService();
      const result = await service.creditWithLock(ORG, "TEST", -100, "order-1", "refund");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Credit amount must be positive");
      }
    });

    it("should reject zero credit amounts", async () => {
      const service = createMockService();
      const result = await service.creditWithLock(ORG, "TEST", 0, "order-1", "refund");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Credit amount must be positive");
      }
    });
  });

  describe("create", () => {
    it("should reject negative amounts", async () => {
      const service = createMockService();
      const result = await service.create(ORG, { amount: -100, currency: "EUR" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Amount must be positive");
      }
    });

    it("should reject zero amounts", async () => {
      const service = createMockService();
      const result = await service.create(ORG, { amount: 0, currency: "EUR" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Amount must be positive");
      }
    });

    it("should reject amounts exceeding maxBalancePerCard", async () => {
      const service = createMockService({ maxBalancePerCard: 10000 });
      const result = await service.create(ORG, { amount: 20000, currency: "EUR" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("exceeds maximum");
      }
    });
  });
});
