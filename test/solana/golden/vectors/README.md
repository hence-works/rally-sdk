`rust-vectors.json` is produced by `main.rs`, which calls the Rally program crate's own
`math::{tick_math, liquidity, curve}` (the Rust that Raydium's math was vendored into), so the
TypeScript port is checked against the real implementation rather than against itself.

To regenerate, from a scratch crate OUTSIDE the repo (do not add it to `packages/rally-solana`):

    [dependencies]
    rally-solana-protocol = { path = "<repo>/packages/rally-solana/programs/rally-solana-protocol", features = ["no-entrypoint", "devnet"] }
    anchor-lang = "=1.0.2"

copy `packages/rally-solana/Cargo.lock` next to it (so versions resolve identically), drop `main.rs`
in `src/`, `cargo run --release`, and fold the `SQRT/TICK/L0/L1/D0/D1/AFL/CURVE/POS/BUY` lines into JSON.
