#!/bin/bash
# 部署脚本：给静态资源打版本号再上线。
# 为什么：Safari 会把 app.js / style.css 缓存住不重新拉（哪怕服务器说 must-revalidate），
# 用户就一直跑旧代码。资源地址带上 ?v=时间戳，每次部署地址都变，浏览器只能重新下载。
set -e
cd "$(dirname "$0")"
V=$(date +%Y%m%d%H%M%S)
sed -i '' -E "s#(href=\"\./style\.css)(\?v=[0-9]+)?\"#\1?v=$V\"#" public/index.html
sed -i '' -E "s#(src=\"\./app\.js)(\?v=[0-9]+)?\"#\1?v=$V\"#"    public/index.html
sed -i '' -E "s#(from '\./(qr|seed)\.js)(\?v=[0-9]+)?'#\1?v=$V'#g" public/app.js
echo "资源版本 $V"
npx --yes wrangler@4 deploy
