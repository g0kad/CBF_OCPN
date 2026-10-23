#!/bin/sh
# Copy the library and plugin script to the OpenCPN Pi.
# Uses Windows OpenSSH so the Windows ssh-agent key is available.
HOST=${1:-pi@openplotter.local}
SSH=/c/Windows/System32/OpenSSH/ssh.exe
SCP=/c/Windows/System32/OpenSSH/scp.exe
cd "$(dirname "$0")/.." || exit 1
$SSH -o BatchMode=yes "$HOST" "mkdir -p ~/CBF_OCPN/src ~/CBF_OCPN/plugin" &&
$SCP -q -o BatchMode=yes src/cbf.js "$HOST":CBF_OCPN/src/ &&
$SCP -q -o BatchMode=yes plugin/CrossBearingFix.js "$HOST":CBF_OCPN/plugin/ &&
echo "Deployed to $HOST:~/CBF_OCPN"
