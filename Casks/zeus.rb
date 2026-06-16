cask "zeus" do
  version "0.1.0"
  sha256 "0610d3b917feb0db9e285efd51d4b3dfc602669776152f0252b4993ff9465c4d"

  url "https://github.com/imchenway/zeus/releases/download/v#{version}/Zeus-#{version}-arm64.dmg"
  name "Zeus"
  desc "Local-first macOS AI development workbench"
  homepage "https://github.com/imchenway/zeus"

  app "Zeus.app"

  uninstall launchctl: "dev.hypha.zeus",
            quit:      "dev.hypha.zeus"

  zap trash: [
    "~/Library/Application Support/Zeus",
    "~/Library/Caches/dev.hypha.zeus",
    "~/Library/Logs/Zeus",
    "~/Library/Preferences/dev.hypha.zeus.plist",
  ]
end
