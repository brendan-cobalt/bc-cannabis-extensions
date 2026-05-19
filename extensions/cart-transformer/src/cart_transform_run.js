// @ts-check

/**
 * BC Cannabis — Container Deposit Fee (CDF) cart transform.
 *
 * @typedef {import("../generated/api").CartTransformRunInput} CartTransformRunInput
 * @typedef {import("../generated/api").CartTransformRunResult} CartTransformRunResult
 * @typedef {import("../generated/api").Operation} Operation
 */

const FEE_TIERS = /** @type {const} */ (["CD005", "CD010", "CD020"]);

// Label used in the customer-facing fee description.
const FEE_SKU_TO_PRICE_LABEL = {
  CD005: "$0.05",
  CD010: "$0.10",
  CD020: "$0.20",
};

// Per-unit price applied to the expanded child line. Must match the fee
// variant's catalog price on both stores.
const FEE_SKU_TO_UNIT_PRICE = {
  CD005: 0.05,
  CD010: 0.10,
  CD020: 0.20,
};

/** @type {CartTransformRunResult} */
const NO_CHANGES = { operations: [] };

/**
 * @param {CartTransformRunInput} input
 * @returns {CartTransformRunResult}
 */
export function cartTransformRun(input) {
  // Pass 1: bucket cart lines by CDF tier into merch lines and fee lines.
  /** @type {Record<string, { line: any, requiredQty: number }[]>} */
  const merchByTier = { CD005: [], CD010: [], CD020: [] };
  /** @type {Record<string, any[]>} */
  const feesByTier = { CD005: [], CD010: [], CD020: [] };

  for (const line of input.cart.lines) {
    if (line.merchandise.__typename !== "ProductVariant") continue;
    const variant = line.merchandise;
    const sku = variant.sku ?? "";

    // A fee line is identified by product type "Fee" + CDxxx variant SKU.
    if (variant.product?.productType === "Fee" && isFeeTier(sku)) {
      feesByTier[sku].push(line);
      continue;
    }

    // A merch-with-CDF line is identified by the `cdf` attribute set by the theme.
    // Anything without `cdf` is left untouched.
    const cdf = line.cdf?.value;
    if (!cdf || !isFeeTier(cdf)) continue;

    // case_size defaults to 1 so the same formula serves D2C (no case_size)
    // and Wholesale (case_size set). consumer_units mirrors the legacy default.
    const consumerUnits = positiveIntOrDefault(line.consumerUnits?.value, 1);
    const caseSize = positiveIntOrDefault(line.caseSize?.value, 1);
    const requiredQty = line.quantity * consumerUnits * caseSize;
    if (requiredQty <= 0) continue;

    merchByTier[cdf].push({ line, requiredQty });
  }

  // Pass 2: for each tier, zip merch lines with fee lines in input order and
  // emit one lineExpand per pair. Pairing by input order matches the legacy
  // Ruby script's "first available fee line of this SKU wins" behaviour.
  /** @type {Operation[]} */
  const operations = [];

  for (const tier of FEE_TIERS) {
    const merchPairs = merchByTier[tier];
    const feeLines = feesByTier[tier];
    // Aggregate count across all pairs of this tier, used in the description text
    // ("applies to N items in this order") — matches legacy presentation.
    const tierTotal = merchPairs.reduce((sum, p) => sum + p.requiredQty, 0);
    const feeCostLabel = FEE_SKU_TO_PRICE_LABEL[tier];
    const pairCount = Math.min(merchPairs.length, feeLines.length);
    const tierUnitPriceString = FEE_SKU_TO_UNIT_PRICE[tier].toFixed(2);

    for (let i = 0; i < pairCount; i++) {
      const { line: merchLine, requiredQty } = merchPairs[i];
      const feeLine = feeLines[i];
      const merchVariant = merchLine.merchandise;
      const feeVariant = feeLine.merchandise;

      operations.push({
        lineExpand: {
          cartLineId: feeLine.id,
          expandedCartItems: [
            {
              merchandiseId: feeVariant.id,
              quantity: requiredQty,
              price: {
                adjustment: {
                  fixedPricePerUnit: {
                    amount: tierUnitPriceString,
                  },
                },
              },
              // Back-pointer attributes on the fee child, mirroring the legacy
              // Ruby script. Order webhooks / downstream systems can use these
              // to link a fee line back to the originating merchandise.
              attributes: [
                { key: "id", value: numericIdFromGid(merchVariant.id) },
                { key: "sku", value: merchVariant.sku ?? "" },
                {
                  key: "_legacy_product_as_fee_title",
                  value: `Container deposit fee (${feeCostLabel})`,
                },
                {
                  key: "_legacy_product_as_fee_description",
                  value: `A container deposit fee of ${feeCostLabel} applies to ${tierTotal} item(s) in this order.`,
                },
              ],
            },
          ],
        },
      });
    }
  }

  return operations.length > 0 ? { operations } : NO_CHANGES;
}

/**
 * @param {string} sku
 * @returns {sku is "CD005" | "CD010" | "CD020"}
 */
function isFeeTier(sku) {
  return sku === "CD005" || sku === "CD010" || sku === "CD020";
}

/**
 * @param {string | null | undefined} value
 * @param {number} fallback
 */
function positiveIntOrDefault(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Convert a Shopify GID (e.g. `gid://shopify/ProductVariant/30262235760460`)
 * to its bare numeric id, matching the legacy line-item property format that
 * downstream order consumers expect.
 *
 * @param {string} gid
 */
function numericIdFromGid(gid) {
  const tail = gid.split("/").pop();
  return tail && tail.length > 0 ? tail : gid;
}
