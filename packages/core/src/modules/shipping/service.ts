import type { CommerceConfig } from "../../config/types.js";
import { Ok, type Result } from "../../kernel/result.js";
import type { TxContext } from "../../kernel/database/tx-context.js";
import type { CatalogRepository } from "../catalog/repository/index.js";
import {
  calculateShippingCost,
  type ShippingAddress,
  type ShippingLineItem,
} from "./calculator.js";

interface ShippingServiceDeps {
  config: CommerceConfig;
  catalogRepository: CatalogRepository;
}

export interface CalculateShippingInput {
  lineItems: ShippingLineItem[];
  subtotalAfterDiscount: number;
  currency: string;
  address?: ShippingAddress;
  isFreeShipping?: boolean;
}

export class ShippingService {
  private readonly catalogRepo: CatalogRepository;

  constructor(private deps: ShippingServiceDeps) {
    this.catalogRepo = deps.catalogRepository;
  }

  async calculate(
    input: CalculateShippingInput,
    ctx?: TxContext,
  ): Promise<
    Result<{ amount: number; strategy: string; weightGrams: number }>
  > {
    const result = await calculateShippingCost(
      this.deps.config,
      this.catalogRepo,
      {
        lineItems: input.lineItems,
        subtotalAfterDiscount: input.subtotalAfterDiscount,
        currency: input.currency,
        isFreeShipping: input.isFreeShipping ?? false,
        ...(input.address !== undefined ? { address: input.address } : {}),
      },
      ctx,
    );
    return Ok(result);
  }
}
