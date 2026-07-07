import { Router, Request, Response } from "express";
import {
  createPayment,
  getPayment,
  ValidationError,
  IdempotencyConflictError,
  PaymentNotFoundError,
} from "../services/paymentService";
import { fromMinorUnits } from "../utils/amountValidator";
import { logger } from "../logger";

const router = Router();

function toResponse(payment: ReturnType<typeof Object.assign>) {
  // Convert stored minor-units amount back to major units for API consumers
  const majorAmount = Number((payment.amount / 100).toFixed(2));

  const response: any = {
    paymentId: payment.id,
    organisationId: payment.organisationId,
    customerReference: payment.customerReference,
    amount: Number.isInteger(majorAmount) ? Math.trunc(majorAmount) : majorAmount,
    currency: payment.currency,
    status: payment.status,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };

  // Include optional fields only if present
  if (payment.description) response.description = payment.description;
  if (payment.providerReference) response.providerReference = payment.providerReference;
  if (payment.failureCode) response.failureCode = payment.failureCode;
  if (payment.failureMessage) response.failureMessage = payment.failureMessage;

  return response;
}

router.post("/payments", async (req: Request, res: Response) => {
  const idempotencyKey = req.headers["idempotency-key"] as string | undefined;

  try {
    const { payment, isReplay } = await createPayment(req.body, idempotencyKey ?? "");
    return res.status(isReplay ? 200 : 201).json(toResponse(payment));
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.code, message: err.message });
    }
    if (err instanceof IdempotencyConflictError) {
      return res.status(409).json({ error: "idempotency_key_reused", message: err.message });
    }
    logger.error("create_payment_error", { error: (err as Error).message });
    return res.status(500).json({ error: "internal_error", message: "An unexpected error occurred" });
  }
});

router.get("/payments/:paymentId", async (req: Request, res: Response) => {
  try {
    const payment = await getPayment(req.params.paymentId);
    return res.json(toResponse(payment));
  } catch (err) {
    if (err instanceof PaymentNotFoundError) {
      return res.status(404).json({ error: "payment_not_found", message: err.message });
    }
    logger.error("get_payment_error", { error: (err as Error).message });
    return res.status(500).json({ error: "internal_error", message: "An unexpected error occurred" });
  }
});

export default router;
