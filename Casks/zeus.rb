cask "zeus" do
  version "0.4.57"
  sha256 "cc8432312b1a02f3aa720431945438ce62802107f3a67fe6b503aba9dcc030ac"

  url "https://zeus-download.hyphatech.cn/zeus/releases/#{version}/Zeus-#{version}-arm64.dmg"
  name "Zeus"
  desc "Local-first AI development workbench"
  homepage "https://github.com/imchenway/zeus"

  depends_on :macos
  depends_on arch: :arm64

  app "Zeus.app"

  uninstall quit: "dev.hypha.zeus"

  zap trash: [
    "~/Library/Application Support/Zeus",
    "~/Library/Caches/dev.hypha.zeus",
    "~/Library/Logs/Zeus",
    "~/Library/Preferences/dev.hypha.zeus.plist",
  ]
end
