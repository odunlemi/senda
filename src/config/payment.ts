/**
 * Senda MVP payment configuration. Keep this intentionally narrow until the
 * direct Base/USDC payment path is reliable.
 */
export const paymentConfig = {
  chain: "base",
  chainId: 8453,
  asset: "USDC",
  assetContractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  requiredConfirmations: 1,
  approvalRequired: true,
} as const;

export type SendaChain = typeof paymentConfig.chain;
export type SendaAsset = typeof paymentConfig.asset;
