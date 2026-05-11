import Stripe from "stripe";
import {
  Err,
  Ok,
  type PaymentAdapter,
  type PaymentCapture,
  type PaymentIntent,
  type PaymentRefund,
  type PaymentWebhookEvent,
  type Result,
} from "@porulle/core";

export interface StripeAdapterOptions {
  secretKey: string;
  webhookSecret?: string;
  apiVersion?: Stripe.LatestApiVersion;
}

export function stripePayment(options: StripeAdapterOptions): PaymentAdapter {
  const stripe = new Stripe(options.secretKey, {
    apiVersion: options.apiVersion ?? "2025-08-27.basil",
  });

  return {
    providerId: "stripe",

    async createPaymentIntent(params): Promise<Result<PaymentIntent>> {
      try {
        const intent = await stripe.paymentIntents.create({
          amount: params.amount,
          currency: params.currency.toLowerCase(),
          metadata: {
            orderId: params.orderId,
            customerId: params.customerId ?? "",
            ...params.metadata,
          },
          automatic_payment_methods: {
            enabled: true,
          },
        });

        return Ok({
          id: intent.id,
          status: intent.status,
          amount: intent.amount,
          currency: intent.currency,
          clientSecret: intent.client_secret,
        });
      } catch (error) {
        return Err({
          code: "PAYMENT_INTENT_CREATE_FAILED",
          message: error instanceof Error ? error.message : "Stripe payment intent creation failed.",
        });
      }
    },

    async capturePayment(paymentIntentId: string, amount?: number): Promise<Result<PaymentCapture>> {
      try {
        const captured = await stripe.paymentIntents.capture(paymentIntentId, amount ? { amount_to_capture: amount } : undefined);
        return Ok({
          id: captured.id,
          status: captured.status,
          amountCaptured: captured.amount_received,
        });
      } catch (error) {
        return Err({
          code: "PAYMENT_CAPTURE_FAILED",
          message: error instanceof Error ? error.message : "Stripe capture failed.",
        });
      }
    },

    async refundPayment(paymentId: string, amount: number, reason?: string): Promise<Result<PaymentRefund>> {
      try {
        const params: Stripe.RefundCreateParams = {
          payment_intent: paymentId,
          amount,
        };
        if (reason != null) {
          // Single-cast: `string` to Stripe's `Reason` enum — structurally compatible
          (params as Record<string, unknown>).reason = reason;
        }
        const refund = await stripe.refunds.create(params);

        return Ok({
          id: refund.id,
          status: refund.status ?? "pending",
          amountRefunded: refund.amount,
        });
      } catch (error) {
        return Err({
          code: "PAYMENT_REFUND_FAILED",
          message: error instanceof Error ? error.message : "Stripe refund failed.",
        });
      }
    },

    async cancelPaymentIntent(paymentIntentId: string): Promise<Result<void>> {
      try {
        await stripe.paymentIntents.cancel(paymentIntentId);
        return Ok(undefined);
      } catch (error) {
        return Err({
          code: "PAYMENT_CANCEL_FAILED",
          message: error instanceof Error ? error.message : "Stripe cancellation failed.",
        });
      }
    },

    async verifyWebhook(request: Request): Promise<Result<PaymentWebhookEvent>> {
      try {
        if (!options.webhookSecret) {
          return Err({
            code: "WEBHOOK_SECRET_MISSING",
            message: "Stripe webhook secret is not configured.",
          });
        }

        const signature = request.headers.get("stripe-signature");
        if (!signature) {
          return Err({
            code: "WEBHOOK_SIGNATURE_MISSING",
            message: "Missing stripe-signature header.",
          });
        }

        const body = await request.text();
        const event = stripe.webhooks.constructEvent(body, signature, options.webhookSecret);

        return Ok({
          id: event.id,
          type: event.type,
          data: event.data.object,
        });
      } catch (error) {
        return Err({
          code: "WEBHOOK_VERIFICATION_FAILED",
          message: error instanceof Error ? error.message : "Stripe webhook verification failed.",
        });
      }
    },
  };
}
