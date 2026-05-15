// @ts-check

/**
 * @typedef {import("../generated/api").CartTransformRunInput} CartTransformRunInput
 * @typedef {import("../generated/api").CartTransformRunResult} CartTransformRunResult
 * @typedef {import("../generated/api").Operation} Operation
 */

const FEE_TIERS = /** @type {const} */ (["CD005", "CD010", "CD020"]);

const FEE_SKU_TO_PRICE_LABEL = {
  CD005: "$0.05",
  CD010: "$0.10",
  CD020: "$0.20",
};

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
  // DEBUG: function entry — confirms the function is being invoked and logs raw cart shape
  console.log(`[DEBUG] cartTransformRun invoked. lines=${input.cart.lines.length}`);
  console.log(`[DEBUG] full input: ${JSON.stringify(input)}`);

  /** @type {Record<string, { line: any, requiredQty: number }[]>} */
  const merchByTier = { CD005: [], CD010: [], CD020: [] };
  /** @type {Record<string, any[]>} */
  const feesByTier = { CD005: [], CD010: [], CD020: [] };

  for (const line of input.cart.lines) {
    if (line.merchandise.__typename !== "ProductVariant") {
      // DEBUG: skipping CustomProduct or other non-variant merchandise
      console.log(`[DEBUG] skip line ${line.id}: merchandise.__typename=${line.merchandise.__typename}`);
      continue;
    }
    const variant = line.merchandise;
    const sku = variant.sku ?? "";

    if (variant.product?.productType === "Fee" && isFeeTier(sku)) {
      // DEBUG: classified as a fee line, bucketed by tier (its own SKU)
      console.log(`[DEBUG] FEE LINE detected: lineId=${line.id} sku=${sku} qty=${line.quantity}`);
      feesByTier[sku].push(line);
      continue;
    }

    const cdf = line.cdf?.value;
    if (!cdf || !isFeeTier(cdf)) {
      // DEBUG: merch line without a usable cdf attribute — leave alone
      console.log(`[DEBUG] skip merch line ${line.id}: productType=${variant.product?.productType} sku=${sku} cdf=${JSON.stringify(line.cdf)}`);
      continue;
    }

    const consumerUnits = positiveIntOrDefault(line.consumerUnits?.value, 1);
    const caseSize = positiveIntOrDefault(line.caseSize?.value, 1);
    const requiredQty = line.quantity * consumerUnits * caseSize;
    // DEBUG: classified as merch-with-CDF, including the computed required fee qty
    console.log(`[DEBUG] MERCH WITH CDF: lineId=${line.id} sku=${sku} cdf=${cdf} qty=${line.quantity} consumerUnits=${consumerUnits} caseSize=${caseSize} requiredQty=${requiredQty}`);
    if (requiredQty <= 0) continue;

    merchByTier[cdf].push({ line, requiredQty });
  }

  // DEBUG: bucketing summary across all three tiers
  console.log(`[DEBUG] bucket summary: ${JSON.stringify({
    CD005: { merch: merchByTier.CD005.length, fees: feesByTier.CD005.length },
    CD010: { merch: merchByTier.CD010.length, fees: feesByTier.CD010.length },
    CD020: { merch: merchByTier.CD020.length, fees: feesByTier.CD020.length },
  })}`);

  /** @type {Operation[]} */
  const operations = [];

  for (const tier of FEE_TIERS) {
    const merchPairs = merchByTier[tier];
    const feeLines = feesByTier[tier];
    const tierTotal = merchPairs.reduce((sum, p) => sum + p.requiredQty, 0);
    const feeCostLabel = FEE_SKU_TO_PRICE_LABEL[tier];
    const pairCount = Math.min(merchPairs.length, feeLines.length);

    // DEBUG: per-tier zip summary — if pairCount < merchPairs.length we have unpaired merch (missing fee lines)
    console.log(`[DEBUG] tier ${tier}: merch=${merchPairs.length} fees=${feeLines.length} pairs=${pairCount} tierTotal=${tierTotal}`);

    const tierUnitPrice = FEE_SKU_TO_UNIT_PRICE[tier];
    const tierUnitPriceString = tierUnitPrice.toFixed(2);

    for (let i = 0; i < pairCount; i++) {
      const { line: merchLine, requiredQty } = merchPairs[i];
      const feeLine = feeLines[i];
      const merchVariant = merchLine.merchandise;
      const feeVariant = feeLine.merchandise;
      // For reference: total fee charge = requiredQty × tierUnitPrice.
      // We achieve this by setting the expanded child's per-unit price explicitly,
      // so the child line contributes `requiredQty × tierUnitPrice` to the cart subtotal.
      const totalFeeAmount = (requiredQty * tierUnitPrice).toFixed(2);

      // DEBUG: each pair we will emit a lineExpand operation for
      console.log(`[DEBUG] PAIR ${tier} #${i}: feeLineId=${feeLine.id} merchLineId=${merchLine.id} requiredQty=${requiredQty} childUnitPrice=${tierUnitPriceString} totalFeeAmount=${totalFeeAmount}`);

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

  // DEBUG: final result — operations count and full output payload
  console.log(`[DEBUG] emitting ${operations.length} operation(s)`);
  console.log(`[DEBUG] output: ${JSON.stringify({ operations })}`);

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
 * to its bare numeric id, matching the legacy line-item property format.
 * @param {string} gid
 */
function numericIdFromGid(gid) {
  const tail = gid.split("/").pop();
  return tail && tail.length > 0 ? tail : gid;
}
