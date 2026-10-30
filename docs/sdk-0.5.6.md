# SDK 0.5.6: explicit media environments

Media application, asset, generation and generation-notification parsers preserve optional environment (live/sandbox). Legacy missing environment means live only for an explicitly pinned client; legacy consumers without expected_environment retain their existing transport behavior.

createMediaEngineClient accepts optional expected_environment. It validates application identity before calling other endpoints and refuses mismatched application/asset/generation responses, including paginated items and upload/URL wrappers. The host must still keep sandbox wallets separate, label samples, validate mock versus environment, and pin request application/environment snapshots.

verifyMediaEngineNotification / verifyMediaEngineEvent accept optional expected_environment after the existing raw-byte HMAC and application/event binding checks. No signing contract, payment or credits schema changed.

Validation: media transport/actions/environment tests 16 passed; packaging tests 2 passed; pnpm pack:sdk passed. No paid provider calls.
