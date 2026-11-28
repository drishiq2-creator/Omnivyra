# Architecture Decision Records — platform controllers

This directory holds platform-wide ADRs, numbered `ADR-NNNN`. It is separate from
`docs/company-intelligence/adr/` (ADR-001..010, the company-intelligence constitution);
the four-digit numbering keeps the two series from being confused.

| ADR | Decision | Status |
|---|---|---|
| [ADR-0001](ADR-0001-five-controllers-and-shared-services.md) | Five controllers + a shared-service layer | Proposed |
| [ADR-0002](ADR-0002-event-envelope-and-delivery-semantics.md) | Versioned event envelope; at-least-once delivery; no durable outbox exists yet | Proposed |
| [ADR-0003](ADR-0003-voice-sdr-contract-only.md) | Voice SDR is contract-only | Proposed |

Contracts: `backend/contracts/controllers/`. Tests: `backend/tests/unit/controllerContracts.test.ts`.
