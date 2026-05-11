/**
 * POS Payment Adapter for the checkout pipeline.
 *
 * POS payments are collected at the terminal before checkout is called.
 * The adapter acts as a pass-through: payment has already been tendered,
 * so authorize/capture are no-ops.
 */

export interface PaymentAdapter {
  providerId: string;
  createPaymentIntent(params: {
    amount: number;
    currency: string;
    orderId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string; status: string; amount: number; clientSecret?: string }>;
  capturePayment(intentId: string, amount: number): Promise<{ id: string; status: string; amountCaptured: number }>;
  refundPayment(paymentId: string, amount: number): Promise<{ id: string; status: string; amountRefunded: number }>;
}

export function createPOSPaymentAdapter(): PaymentAdapter {
  return {
    providerId: "pos",

    async createPaymentIntent(params) {
      // POS payments are already collected at the terminal.
      // The "intent" represents the sum of pos_payments rows.
      return {
        id: `pos_${params.orderId ?? crypto.randomUUID()}`,
        status: "requires_capture",
        amount: params.amount,
      };
    },

    async capturePayment(intentId, amount) {
      // POS payments are already collected. Capture is a no-op.
      return {
        id: intentId,
        status: "succeeded",
        amountCaptured: amount,
      };
    },

    async refundPayment(paymentId, amount) {
      // POS refunds are handled by the return transaction flow.
      return {
        id: `ref_${paymentId}`,
        status: "succeeded",
        amountRefunded: amount,
      };
    },
  };
}
