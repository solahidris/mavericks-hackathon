# Devnet verification — September 13, 2026

Deployment: https://relay-a2a-marketplace.emailsolah.workers.dev

## Deployed paid chain

Task `ffa679c1-128e-4283-8064-de553522d0a4` reached `released` with `"money" → [13,15,14,5,25] → 72`. The test checked each seller's USDC balance increased by 0.001.

- [Buyer payment](https://explorer.solana.com/tx/zJ4cNRMoTo1eQgk7ZA9m2FPBL9quR5QpzaE74swHPMiFjgovv18wG4NDoaaBCu3Qxhejnwq8pLsr2SffbUq94Xh?cluster=devnet)
- [Agent A payment](https://explorer.solana.com/tx/dTUt2AWUCvGYXHwPJTvoHcWQjkRQMgswxzBJt5cDkueFQCZe4zWwWHDWussfCEUHEg21m4dH2B2WaUdyFbMQw94?cluster=devnet)
- [Agent B payment](https://explorer.solana.com/tx/3PgwXPPmfTiKmSdH9WpmqFinCsy5TofFG71J1RJgTMek7WhTh2BLwTYvRH8VcKUkezcMWuMQ3cYZyQeUEYr8MyHX?cluster=devnet)

## Deployed automatic refund

Task `2747e660-1244-447c-b32a-8d90900c331e` used invalid input `"money!"`. It reached `refunded`; the buyer's USDC balance returned to its starting value and seller balances stayed unchanged.

- [Buyer payment](https://explorer.solana.com/tx/5Mz1R1gVUYj3J2JdATmdYXhnZNPvRnNTZeJ6inxkRANyob37x3zPiyZQAb97q49kswRgrkaKk6SYCv1gNi2iyrZs?cluster=devnet)
- [Confirmed refund](https://explorer.solana.com/tx/2xyasSL45Q1mxAZtZjGB39Td6SAsKvcS3oscVtMj4x64ig9QPwEaP38HSN9M48iju55kaRNxvdSArWgh5suoj9VU?cluster=devnet)

## Browser and integration checks

- Real browser x402 payment through the Wallet Adapter signing bridge completed the chain and displayed 72 plus receipts. This used the development-only generated buyer adapter; a manual Phantom extension signature was not tested.
- Local HTTP/D1 integration passed routing, concurrent/idempotent requests, task authorization, incompatible chains, third-agent registration and malformed-output refunds.
- Five logic/payment validation unit tests passed.
- Responsive directory, task flow, registration duplicate error, and mobile/tablet layouts were inspected in the browser.

The Worker uses Helius's free public devnet sandbox to avoid the canonical public RPC's HTTP 403 from Cloudflare. The sandbox needs no account or API key. It is shared infrastructure; see the README for RPC configuration and conservative settlement recovery limitations.
