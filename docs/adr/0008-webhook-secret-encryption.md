# ADR-0008: Webhook signing secrets are encrypted, not hashed

- Status: Accepted
- Date: 2025-02-07

## Context

API keys are stored as a peppered HMAC (ADR-0007): the server only ever needs to
*compare* a presented value. Webhook signing secrets are different — the server
must *reproduce* the HMAC on every delivery attempt, so it needs the original
bytes. Hashing them is not an option; the question is only how the plaintext is
protected.

## Decision

Generate a 32-byte secret (`whsec_<base64url>`), show it to the operator exactly
once (on creation and on rotation), and store it as an AES-256-GCM envelope
(`v1.<iv>.<tag>.<ciphertext>`) keyed by `WEBHOOK_SECRET_KEY`, which lives in the
secret store and never in the database.

## Rationale

- **One-time display** keeps the operator's copy authoritative and makes the
  "we cannot show it again, rotate instead" support answer honest.
- **Encryption, not hashing**, is forced by HMAC signing. Pretending otherwise
  would mean either signing with a hash (equivalent to storing plaintext under a
  different name) or dropping signatures.
- **AES-256-GCM** is authenticated, so a tampered ciphertext fails loudly rather
  than yielding garbage that would produce silently invalid signatures.
- **Versioned envelope** (`v1.`) leaves room to re-encrypt under a new key
  without a schema change.
- **KMS/HSM rejected for now**: a per-delivery network call to KMS on the hot
  path is a worse trade than an env-held key, and the deployment target has no
  KMS. If one appears, the envelope becomes `v2.` with a wrapped data key.

## Consequences

- Positive: signatures are real HMACs; the database alone is not enough to forge
  one; rotation is a single API call.
- Negative: `WEBHOOK_SECRET_KEY` is now a crown-jewel secret — losing it means
  every endpoint must rotate; leaking it plus a database dump exposes secrets.
  Production boot refuses the built-in development key.
- Key rotation is not yet automated: re-encrypting existing rows under a new key
  is a documented manual step (read `v1` rows, re-encrypt, write back).
