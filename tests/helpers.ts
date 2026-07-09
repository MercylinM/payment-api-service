import { Pool } from "pg";
import { runMigrations } from "../src/db/migrate";

export const testPool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://payments:payments@localhost:5432/payments",
});

export async function setupDb(): Promise<void> {
  await runMigrations();
}

export async function cleanDb(): Promise<void> {
  await testPool.query("TRUNCATE payment_attempts, payment_outbox, payments CASCADE");
}

export async function teardownDb(): Promise<void> {
  await testPool.end();
}

export const validPayload = {
  organisationId: "8b24a9b4-58f5-42f1-a6ef-697cfb321164",
  customerReference: "INV-2026-001",
  amount: 1500.00,
  currency: "KES",
  recipient: { type: "MOBILE_MONEY", phoneNumber: "+254712345678" },
  description: "Supplier payment",
};
