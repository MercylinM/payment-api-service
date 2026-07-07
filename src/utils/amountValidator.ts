/**
 * Amount Validation and Normalization
 * 
 * Ensures monetary amounts are:
 * - Canonicalized to minor units (cents) for deterministic hashing
 * - Validated as positive integers
 * - Free from floating-point precision issues
 */

import Decimal from 'decimal.js';

/**
 * Converts a monetary amount to minor units (cents)
 * 
 * Examples:
 * - "1500.50" → 150050 cents
 * - "1500" → 150000 cents
 * - 1500.50 → 150050 cents
 * 
 * @param amount - Amount as string, number, or Decimal
 * @returns Amount in minor units (integer)
 * @throws Error if amount is invalid or negative
 */
export function toMinorUnits(amount: string | number | any): number {
  const decimal = new Decimal(amount);

  // Validate: must be positive
  if (decimal.isNegative() || decimal.isZero()) {
    throw new Error(`Amount must be positive, got: ${amount}`);
  }

  // Validate: max 2 decimal places
  if (decimal.decimalPlaces() > 2) {
    throw new Error(
      `Amount has too many decimal places. Maximum 2 allowed, got: ${amount}`
    );
  }

  // Convert to minor units: multiply by 100 and round to integer
  const minorUnits = decimal.times(100).toNumber();

  // Verify result is a valid integer
  if (!Number.isInteger(minorUnits) || minorUnits <= 0) {
    throw new Error(
      `Failed to convert amount to minor units: ${amount} → ${minorUnits}`
    );
  }

  return minorUnits;
}

/**
 * Converts minor units (cents) back to major units (dollars)
 * 
 * Examples:
 * - 150050 cents → "1500.50"
 * - 150000 cents → "1500.00"
 * 
 * @param minorUnits - Amount in cents
 * @returns Amount in dollars as Decimal
 */
export function fromMinorUnits(minorUnits: number): any {
  if (!Number.isInteger(minorUnits) || minorUnits <= 0) {
    throw new Error(
      `Invalid minor units: must be positive integer, got: ${minorUnits}`
    );
  }

  return new Decimal(minorUnits).dividedBy(100);
}

/**
 * Canonicalizes request data for deterministic hashing
 * 
 * Rules:
 * - Convert amount to minor units (integer, no precision loss)
 * - Sort all keys alphabetically
 * - Remove null/undefined values
 * 
 * @param data - Request data
 * @returns Canonicalized object safe for hashing
 */
export function canonicalizeForHashing(data: any): any {
  const canonical: any = {};

  // Process fields in deterministic order
  const orderedKeys = Object.keys(data).sort();

  for (const key of orderedKeys) {
    const value = data[key];

    // Skip null/undefined
    if (value === null || value === undefined) {
      continue;
    }

    // Special handling for amount: convert to minor units
    if (key === 'amount') {
      canonical[key] = toMinorUnits(value);
      continue;
    }

    // Recursively canonicalize nested objects
    if (typeof value === 'object' && !Array.isArray(value)) {
      canonical[key] = canonicalizeForHashing(value);
      continue;
    }

    // For arrays, recursively canonicalize items
    if (Array.isArray(value)) {
      canonical[key] = value.map((item) =>
        typeof item === 'object' ? canonicalizeForHashing(item) : item
      );
      continue;
    }

    // For strings, trim whitespace
    if (typeof value === 'string') {
      canonical[key] = value.trim();
      continue;
    }

    // For everything else, use as-is
    canonical[key] = value;
  }

  return canonical;
}

/**
 * Validates amount against business rules
 * 
 * @param amount - Amount to validate
 * @param currency - Currency code (for future validation)
 * @returns The amount in minor units if valid
 * @throws Error if validation fails
 */
export function validateAmount(
  amount: string | number | any,
  currency?: string
): number {
  try {
    const minorUnits = toMinorUnits(amount);

    // Optional: Add currency-specific limits
    // Example: Some currencies have different maximum amounts
    // if (currency === 'JPY' && minorUnits > 999999999999) { // max 9,999,999.99 JPY in minor units
    //   throw new Error(`Amount exceeds maximum for ${currency}`);
    // }

    return minorUnits;
  } catch (err) {
    throw new Error(
      `Amount validation failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
