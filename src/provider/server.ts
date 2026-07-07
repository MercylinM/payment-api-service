import express from "express";

const app = express();
app.use(express.json());

const MODE = process.env.PROVIDER_MODE || "success";

// Track which requestIds have already been processed (simulates provider idempotency)
const processed = new Map<string, { providerReference: string; status: string }>();

app.post("/provider/payments", async (req, res) => {
  const { requestId, amount, currency, recipient } = req.body;

  if (!requestId || !amount || !currency || !recipient) {
    return res.status(400).json({ error: "missing_fields" });
  }

  // Provider-side idempotency: same requestId always returns same result
  if (processed.has(requestId)) {
    const existing = processed.get(requestId)!;
    return res.json(existing);
  }

  const providerReference = `PROV-${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;

  switch (MODE) {
    case "reject":
      return res.status(422).json({
        error: "payment_rejected",
        message: "Recipient account not found",
      });

    case "timeout":
      // Never respond — simulates a full timeout
      return;

    case "success_then_timeout":
      // Process successfully but drop the response (client never sees it)
      processed.set(requestId, { providerReference, status: "SUCCESS" });
      return; // intentionally no response

    case "error500":
      return res.status(500).json({ error: "internal_error" });

    default: // "success"
      processed.set(requestId, { providerReference, status: "SUCCESS" });
      return res.json({ providerReference, status: "SUCCESS" });
  }
});

const PORT = parseInt(process.env.PORT || "4000", 10);
app.listen(PORT, () => console.log(`Mock provider listening on :${PORT} [mode=${MODE}]`));

export default app;
