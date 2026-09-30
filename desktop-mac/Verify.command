#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
bridge_node="$PWD/../dist/Agent Bridge.app/Contents/Resources/runtime/bin/node"
if [ ! -x "$bridge_node" ]; then
  echo '请先双击 Build.command，完成构建。'
  read -r -p '按回车关闭…' bridge_reply
  exit 1
fi
set +e
"$bridge_node" verify.mjs --isolated --desktop-readonly "$@"
bridge_result=$?
set -e
echo '脱敏报告已写入 dist；请把 macOS-verify-report.json 发回开发聊天。'
read -r -p '按回车关闭窗口…' bridge_reply
exit "$bridge_result"
