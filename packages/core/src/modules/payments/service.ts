import { CommerceValidationError } from "../../kernel/errors.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import type {
  CreatePaymentIntentParams,
  PaymentAdapter,
  PaymentCapture,
  PaymentIntent,
  PaymentRefund,
} from "./adapter.js";

export class PaymentsService {
  private readonly adapterMap: Map<string, PaymentAdapter>;
  private readonly defaultAdapter: PaymentAdapter | undefined;

  constructor(adapters: PaymentAdapter[] | undefined) {
    this.adapterMap = new Map();
    for (const adapter of adapters ?? []) {
      this.adapterMap.set(adapter.providerId, adapter);
    }
    this.defaultAdapter = adapters?.[0];
  }

  /**
   * Resolve a specific adapter by its providerId.
   * Falls back to the default (first) adapter only when paymentMethodId is omitted.
   */
  private resolveAdapter(paymentMethodId?: string): Result<PaymentAdapter> {
    if (paymentMethodId) {
      const adapter = this.adapterMap.get(paymentMethodId);
      if (!adapter) {
        return Err(
          new CommerceValidationError(
            `No payment adapter registered for provider "${paymentMethodId}". ` +
            `Available: [${[...this.adapterMap.keys()].join(", ")}]`,
          ),
        );
      }
      return Ok(adapter);
    }
    if (!this.defaultAdapter) {
      return Err(new CommerceValidationError("No payment adapter configured."));
    }
    return Ok(this.defaultAdapter);
  }

  /** Expose registered provider IDs for validation hooks. */
  get registeredProviderIds(): string[] {
    return [...this.adapterMap.keys()];
  }

  async authorize(
    params: Omit<CreatePaymentIntentParams, "orderId"> & {
      paymentMethodId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Result<PaymentIntent>> {
    const adapter = this.resolveAdapter(params.paymentMethodId);
    if (!adapter.ok) return adapter;

    return adapter.value.createPaymentIntent({
      ...params,
      orderId: String(params.metadata?.orderId ?? "pending-order"),
      metadata: Object.fromEntries(
        Object.entries(params.metadata ?? {}).map(([key, value]) => [
          key,
          String(value),
        ]),
      ),
    });
  }

  async capture(
    paymentIntentId: string,
    amount?: number,
    paymentMethodId?: string,
  ): Promise<Result<PaymentCapture>> {
    const adapter = this.resolveAdapter(paymentMethodId);
    if (!adapter.ok) return adapter;
    return adapter.value.capturePayment(paymentIntentId, amount);
  }

  async refund(
    paymentId: string,
    amount: number,
    reason?: string,
    paymentMethodId?: string,
  ): Promise<Result<PaymentRefund>> {
    const adapter = this.resolveAdapter(paymentMethodId);
    if (!adapter.ok) return adapter;
    return adapter.value.refundPayment(paymentId, amount, reason);
  }

  async cancel(
    paymentIntentId: string,
    paymentMethodId?: string,
  ): Promise<Result<void>> {
    const adapter = this.resolveAdapter(paymentMethodId);
    if (!adapter.ok) return adapter;
    return adapter.value.cancelPaymentIntent(paymentIntentId);
  }

  async verifyWebhook(request: Request) {
    const adapter = this.resolveAdapter();
    if (!adapter.ok) return adapter;
    return adapter.value.verifyWebhook(request);
  }
}
