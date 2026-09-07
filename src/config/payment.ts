/**
 * Senda MVP payment configuration. Keep this intentionally narrow until the
 * direct Base/USDC payment path is reliable.
 */
export const paymentConfig = {
  chain: "base",
  chainId: 8453,
  asset: "USDC",
  assetContractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  // Acceptance threshold for Base payments. This is operational finality,
  // not a guarantee that a deep chain reorg is impossible.
  requiredConfirmations: 12,
  // How long a confirming intent with no on-chain receipt can stay confirming
  // before it is explicitly marked as dropped. This is an operational timeout,
  // not a technical Base requirement.
  confirmingTimeoutMs: 5 * 60 * 1000,
  // Continue checking an unresolved submitted transaction for one day after
  // submission. After this deadline, automated checks stop and operators must
  // review the original hash; a later manual reconciliation can still settle it.
  droppedMonitoringMs: 24 * 60 * 60 * 1000,
  // Operational finality: `paid` intents are terminal for the MVP. Reorg
  // detection is recorded for audit but does not reverse the payment.
  paidIsTerminal: true,
  approvalRequired: true,
} as const;

export type SendaChain = typeof paymentConfig.chain;
export type SendaAsset = typeof paymentConfig.asset;
