#!/bin/bash
set -euo pipefail
bridge_finish() {
  bridge_result=$?
  trap - EXIT
  if [ "$bridge_result" -ne 0 ]; then
    echo "构建未通过（退出码 $bridge_result），请把上方错误信息发回开发聊天。"
  fi
  if [ -t 0 ]; then
    read -r -p '按回车关闭窗口…' bridge_reply || true
  fi
  exit "$bridge_result"
}
trap bridge_finish EXIT
cd "$(dirname "$0")"
bridge_arch="$(/usr/bin/uname -m)"
case "$bridge_arch" in
  arm64) bridge_hash='8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d';;
  x86_64) bridge_arch=x64; bridge_hash='d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316';;
  *) echo '不支持的 Mac 架构'; exit 1;;
esac
bridge_name="node-v24.19.0-darwin-$bridge_arch"
bridge_cache="$PWD/.build/cache"
/bin/mkdir -p "$bridge_cache"
bridge_archive="$bridge_cache/$bridge_name.tar.gz"
if [ ! -f "$bridge_archive" ]; then
  echo '正在下载固定版本官方 Node.js（仅首次构建）…'
  /usr/bin/curl --fail --location --connect-timeout 20 --max-time 180 "https://nodejs.org/dist/v24.19.0/$bridge_name.tar.gz" -o "$bridge_archive.part"
  /bin/mv "$bridge_archive.part" "$bridge_archive"
fi
bridge_actual="$(/usr/bin/shasum -a 256 "$bridge_archive" | /usr/bin/awk '{print $1}')"
if [ "$bridge_actual" != "$bridge_hash" ]; then
  echo 'Node 官方 SHA256 不匹配，停止执行。请移走 .build/cache 中的下载包后重试。'
  exit 1
fi
/usr/bin/tar -xzf "$bridge_archive" -C "$bridge_cache"
echo '正在编译原生窗口并运行检查…'
"$bridge_cache/$bridge_name/bin/node" build.mjs "$@"
echo "输出目录：$(cd .. && pwd)/dist"
echo '请将该目录中的 DMG、app.zip 和 build-report.json 复制回电脑。'
