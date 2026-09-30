#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Install the LTS version of Node.js from https://nodejs.org/en/download"
  echo "Keep the installer defaults, then reopen this launcher."
  read -r -p "Press Enter to close. "
  exit 1
fi
node scripts/launch.mjs "$@"
result=$?
if [ "$result" -ne 0 ]; then
  echo
  echo "The studio could not start. See the message above."
  read -r -p "Press Enter to close. "
fi
exit "$result"
