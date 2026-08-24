#!/usr/bin/env bash
#
# Double-click this in Finder to start the app.
#
# macOS only runs a file in Terminal on double-click when it ends in .command,
# which is why this exists alongside start_web.sh. It just runs that script, so
# there is only one copy of the actual startup steps.

cd "$(dirname "$0")"
./start_web.sh

# Keep the window up if something failed, so the error is readable instead of
# vanishing with the Terminal window.
status=$?
if [ $status -ne 0 ]; then
  echo ""
  echo "The app stopped with an error (exit $status)."
  echo "Press any key to close this window..."
  read -n 1 -s
fi
