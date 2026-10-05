#!/usr/bin/env bash
# Verification script for start-of-session checklist
# Runs: build + tests + 20-game smoke benchmark

set -e

echo "=== Verification Script ==="
echo ""

echo "Step 1: Building..."
npm run build
echo "✓ Build successful"
echo ""

echo "Step 2: Running tests..."
npm test
echo "✓ Tests passed"
echo ""

echo "Step 3: Running 20-game smoke benchmark..."
echo "(This ensures no crashes and fallback rate is 0%)"
node dist/cli/selfplay.js 20 mcts random > /tmp/verify-output.txt 2>&1

# Check for errors
if grep -q "Error" /tmp/verify-output.txt; then
    echo "✗ Smoke benchmark encountered errors:"
    grep "Error" /tmp/verify-output.txt | head -5
    exit 1
fi

# Extract fallback rate
FALLBACK_RATE=$(grep "Fallback rate:" /tmp/verify-output.txt | tail -1 | awk '{print $3}')
echo "Fallback rate: $FALLBACK_RATE"

if [[ "$FALLBACK_RATE" != "0.00%" ]]; then
    echo "✗ Fallback rate is not 0%. Expected 0.00%, got $FALLBACK_RATE"
    exit 1
fi

echo "✓ Smoke benchmark passed (20 games, 0% fallback)"
echo ""

echo "=== All Checks Passed ==="
echo "You're ready to work. Pick a task from docs/state/NEXT.md"
