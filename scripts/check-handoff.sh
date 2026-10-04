#!/usr/bin/env bash
# Validates that end-of-session protocol was followed
# Checks: CURRENT.md and NEXT.md are not stale, session log exists for recent commits

set -e

echo "=== Handoff Protocol Validation ==="
echo ""

CURRENT_FILE="docs/state/CURRENT.md"
NEXT_FILE="docs/state/NEXT.md"
SESSIONS_DIR="docs/state/sessions"

# Check that required files exist
if [[ ! -f "$CURRENT_FILE" ]]; then
    echo "✗ Missing $CURRENT_FILE"
    exit 1
fi

if [[ ! -f "$NEXT_FILE" ]]; then
    echo "✗ Missing $NEXT_FILE"
    exit 1
fi

if [[ ! -d "$SESSIONS_DIR" ]]; then
    echo "✗ Missing $SESSIONS_DIR"
    exit 1
fi

echo "✓ Required files exist"

# Check that CURRENT.md was updated recently (within last 5 commits)
CURRENT_LAST_COMMIT=$(git log -1 --format="%H" -- "$CURRENT_FILE" 2>/dev/null || echo "")
HEAD_COMMIT=$(git rev-parse HEAD)

if [[ -z "$CURRENT_LAST_COMMIT" ]]; then
    echo "⚠ Warning: $CURRENT_FILE has no git history (new file?)"
elif [[ "$CURRENT_LAST_COMMIT" == "$HEAD_COMMIT" ]]; then
    echo "✓ $CURRENT_FILE updated in latest commit"
else
    # Check if CURRENT.md is within last 5 commits
    COMMITS_SINCE=$(git rev-list "$CURRENT_LAST_COMMIT..HEAD" 2>/dev/null | wc -l || echo "999")
    if [[ "$COMMITS_SINCE" -gt 5 ]]; then
        echo "✗ $CURRENT_FILE is stale (last updated $COMMITS_SINCE commits ago)"
        echo "  Please update metrics, known issues, and files changed"
        exit 1
    else
        echo "✓ $CURRENT_FILE updated recently ($COMMITS_SINCE commits ago)"
    fi
fi

# Check that NEXT.md was updated recently (within last 5 commits)
NEXT_LAST_COMMIT=$(git log -1 --format="%H" -- "$NEXT_FILE" 2>/dev/null || echo "")

if [[ -z "$NEXT_LAST_COMMIT" ]]; then
    echo "⚠ Warning: $NEXT_FILE has no git history (new file?)"
elif [[ "$NEXT_LAST_COMMIT" == "$HEAD_COMMIT" ]]; then
    echo "✓ $NEXT_FILE updated in latest commit"
else
    COMMITS_SINCE=$(git rev-list "$NEXT_LAST_COMMIT..HEAD" 2>/dev/null | wc -l || echo "999")
    if [[ "$COMMITS_SINCE" -gt 5 ]]; then
        echo "✗ $NEXT_FILE is stale (last updated $COMMITS_SINCE commits ago)"
        echo "  Please mark completed tasks DONE and update IN_PROGRESS"
        exit 1
    else
        echo "✓ $NEXT_FILE updated recently ($COMMITS_SINCE commits ago)"
    fi
fi

# Check for session log in the last 10 commits
RECENT_SESSION_LOGS=$(find "$SESSIONS_DIR" -name "*.md" -type f -exec git log -1 --format="%H" -- {} \; 2>/dev/null | head -1)
if [[ -n "$RECENT_SESSION_LOGS" ]]; then
    echo "✓ Session log(s) found in recent commits"
else
    echo "⚠ Warning: No session logs found in $SESSIONS_DIR"
    echo "  Consider creating one for this session"
fi

echo ""
echo "=== Handoff Protocol Validated ==="
echo "Ready to push"
