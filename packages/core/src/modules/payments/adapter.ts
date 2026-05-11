import type { Result } from "../../kernel/result.js";

export interface PaymentIntent {
  id: string;
  status: string;
  amount: number;
  currency: string;
  clientSecret?: string | null;
}

export interface PaymentCapture {
  id: string;
  status: string;
  amountCaptured: number;
}

export interface PaymentRefund {
  id: string;
  status: string;
  amountRefunded: number;
}

export interface PaymentWebhookEvent {
  id: string;
  type: string;
  data: unknown;
}

export interface CreatePaymentIntentParams {
  amount: number;
  currency: string;
  orderId: string;
  customerId?: string;
  metadata?: Record<string, string>;
  terminalId?: string;
}

export interface PaymentAdapter {
  readonly providerId: string;
  createPaymentIntent(params: CreatePaymentIntentParams): Promise<Result<PaymentIntent>>;
  capturePayment(paymentIntentId: string, amount?: number): Promise<Result<PaymentCapture>>;
  refundPayment(paymentId: string, amount: number, reason?: string): Promise<Result<PaymentRefund>>;
  cancelPaymentIntent(paymentIntentId: string): Promise<Result<void>>;
  verifyWebhook(request: Request): Promise<Result<PaymentWebhookEvent>>;
}
