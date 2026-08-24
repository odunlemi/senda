/**
 * Senda MVP payment configuration. Keep this intentionally narrow until the
 * direct Base/USDC payment path is reliable.
 */
export const paymentConfig = {
  chain: "base",
  asset: "USDC",
  approvalRequired: true,
} as const;

export type SendaChain = typeof paymentConfig.chain;
export type SendaAsset = typeof paymentConfig.asset;
