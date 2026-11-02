#!/usr/bin/env bash
# Boots a local validator holding the DEPLOYED Rally Solana program and Raydium's devnet CLMM,
# cloned from devnet, for `harness.ts`. Usage: validator.sh <ledger-dir>
# The program under test is therefore the bytecode that is live on devnet, not a local build.
set -euo pipefail
LEDGER=${1:?usage: validator.sh <ledger-dir>}
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
exec solana-test-validator --reset --quiet --ledger "$LEDGER" --url "${CLONE_URL:-https://api.devnet.solana.com}" \
  --clone-upgradeable-program 7mdwZfoJm6iXj3hWsqsbeqExJV6SZ3EYQWnBqGmKGz76 \
  --clone-upgradeable-program DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH \
  --clone-upgradeable-program DRay25Usp3YJAi7beckgpGUC7mGJ2cR1AVPxhYfwVCUX \
  --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s \
  --clone CD4aJtX11cqTCAc83nxSPkkh5JW2yjD6uwHeovjqQ1qu \
  --clone 2r9T3zLRmYtxvyRUBr6yNXs5xe8tRuFYxqgwevuCx9ZR \
  --clone 7E2ipAXfWjX27tHhAYG5JXcguGTdVStB8W1fWyDmFXdE \
  --clone 9sgNggenhpurB6ZbMfu3tUB5dfXQPBvNTSyveZTrxWdA \
  --clone 8VsUtTtjvCiJ3rWEwqS94g4hJcDcAH2jUWYqkBcgF52N
