export type PaymentStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED";

export const VALID_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  PENDING:    ["PROCESSING"],
  PROCESSING: ["PROCESSING", "SUCCESS", "FAILED"],
  SUCCESS:    [],
  FAILED:     [],
};

export const SUPPORTED_CURRENCIES = ["KES", "USD", "EUR", "GBP", "UGX", "TZS"];

export const SUPPORTED_RECIPIENT_TYPES = ["MOBILE_MONEY"];

export type OutboxEventType = "PROCESS_PAYMENT" | "RECONCILE_PAYMENT";
export type OutboxStatus = "PENDING" | "PROCESSING" | "DONE" | "FAILED";

export interface Recipient {
  type: "MOBILE_MONEY";
  phoneNumber?: string;
}

export interface CreatePaymentRequest {
  organisationId: string;
  customerReference: string;
  amount: string | number; // Accepts string or number, will be canonicalized to minor units
  currency: string;
  recipient: Recipient;
  description?: string;
}

export interface Payment {
  id: string;
  organisationId: string;
  idempotencyKey: string;
  requestHash: string;
  customerReference: string;
  amount: number; // Amount in minor units (cents), always an integer
  currency: string;
  recipientType: string;
  recipientValue: string;
  description?: string;
  status: PaymentStatus;
  providerReference?: string;
  failureCode?: string;
  failureMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentAttempt {
  id: string;
  paymentId: string;
  attemptNumber: number;
  providerRequestId?: string;
  status: string;
  requestPayload?: object;
  responsePayload?: object;
  errorCode?: string;
  errorMessage?: string;
  startedAt: Date;
  completedAt?: Date;
}

export interface PaymentOutbox {
  id: string;
  paymentId: string;
  status: OutboxStatus;
  eventType: OutboxEventType;
  payload: object;
  retryCount: number;
  lastError?: string;
  lastRetryAt?: Date;
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
