// @ts-check

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

// B2B max order subtotal — replaces MAX_ORDER_PRICE = Money.new(cents: 35000000) in the legacy Wholesale payment script.
const MAX_ORDER_SUBTOTAL = 350000;

// D2C BC regulatory cap — replaces MAX_GRAMS = 30 in the legacy Stores payment script.
const MAX_GRAM_EQUIVALENCY = 30;

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  /** @type {{ message: string, target: string }[]} */
  const errors = [];

  // ── B2B order-limit gate (per-line, configured via variant metafield or line attribute) ──
  input.cart.lines.forEach((line, index) => {
    const variant = line.merchandise.__typename === "ProductVariant" ? line.merchandise : null;

    const limit =
      parsePositiveInt(variant?.b2bOrderLimitMetafield?.value) ??
      parsePositiveInt(line.b2bOrderLimit?.value);

    if (limit == null) return;
    if (line.quantity <= limit) return;

    const sku = variant?.sku ?? "";
    const skuFragment = sku ? ` (SKU ${sku})` : "";

    errors.push({
      message: `Order limit exceeded${skuFragment}: this product is limited to ${limit} per order.`,
      target: `$.cart.lines[${index}].quantity`,
    });
  });

  // ── B2B cart subtotal cap ($350,000) ──
  const subtotal = parseFloat(input.cart.cost.subtotalAmount.amount);
  if (Number.isFinite(subtotal) && subtotal > MAX_ORDER_SUBTOTAL) {
    errors.push({
      message: `This order exceeds the maximum self-serve subtotal of $${MAX_ORDER_SUBTOTAL.toLocaleString("en-CA")}.`,
      target: "$.cart",
    });
  }

  // ── D2C 30g gram equivalency cap ──
  // Gated to non-B2B carts — B2B retailers can legitimately exceed 30g of cannabis-equivalent product.
  if (!isB2bCart(input)) {
    const totalGrams = input.cart.lines.reduce((sum, line) => {
      const variant = line.merchandise.__typename === "ProductVariant" ? line.merchandise : null;

      const perUnit =
        parseNonNegativeFloat(variant?.gramEquivalencyMetafield?.value) ??
        parseNonNegativeFloat(line.gramEquivalency?.value) ??
        0;

      return sum + perUnit * line.quantity;
    }, 0);

    if (totalGrams > MAX_GRAM_EQUIVALENCY) {
      errors.push({
        message: `BC purchase limit exceeded: cannabis orders are limited to ${MAX_GRAM_EQUIVALENCY}g of dried-cannabis equivalent per transaction.`,
        target: "$.cart",
      });
    }
  }

  return {
    operations: [
      { validationAdd: { errors } },
    ],
  };
}

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {boolean}
 */
function isB2bCart(input) {
  return input.cart.buyerIdentity?.customer?.licenceNumber != null;
}

/**
 * Parses a positive integer from a line-item attribute or metafield value. Returns null for
 * absent values, the `"no_limit"` sentinel, empty strings, or any non-positive / non-numeric input.
 * @param {string | null | undefined} value
 */
function parsePositiveInt(value) {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "no_limit") return null;
  const parsed = parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Parses a non-negative float (grams) from a metafield or attribute value. Returns null for
 * absent / empty / negative / non-numeric input so the caller can fall through to the next source.
 * Explicit `"0"` is preserved as `0` (a deliberate zero-contribution value should not fall through).
 * @param {string | null | undefined} value
 */
function parseNonNegativeFloat(value) {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = parseFloat(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
