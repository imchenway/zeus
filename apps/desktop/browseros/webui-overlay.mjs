/** 四个构建接入点均固定 Chromium 原文和 BrowserOS 补丁摘要，防止错配上游。 */
export const webUiOverlayInputs = [
  {
    /** WebUI 配置注册入口。 */
    path: 'chrome/browser/ui/webui/chrome_web_ui_configs.cc',
    /** 固定 Chromium 修订的原始文件摘要。 */
    baseSha256: 'e96a1eadc4595835fea0148b14edcc2125f5eacd3b439946124f29c029b8d675',
    /** 固定 BrowserOS 修订对应的补丁摘要。 */
    patchSha256: '1465a6cb8eb58eefddecddd2364a046f04fe19f8ecd18e3d7b7d752affb6dc4b',
    /** 每个锚点必须唯一存在，保留 BrowserOS 已有注册。 */
    additions: [
      ['#include "chrome/browser/browseros/onboarding/browseros_onboarding.h"', '\n// 注册 Zeus 可信桌面页面。\n#include "chrome/browser/ui/webui/zeus/zeus_ui.h"'],
      ['  map.AddWebUIConfig(std::make_unique<BrowserOSOnboardingUIConfig>());', '\n  // Zeus 页面只在普通资料中可用。\n  map.AddWebUIConfig(std::make_unique<zeus::ZeusUIConfig>());'],
    ],
  },
  {
    /** WebUI 注册目标的原生依赖。 */
    path: 'chrome/browser/ui/webui/BUILD.gn',
    /** 原始构建文件摘要。 */
    baseSha256: '9bff25e53a6d2ce1b364c7baf03225915f5c9d02bbd22ca01e5cec96b49e994a',
    /** BrowserOS 构建依赖补丁摘要。 */
    patchSha256: '037fcade42971eb6f116daabb3000831e9a5abb5d4b7ae6fbf860912b1975587',
    /** 在同一桌面注册目标中编译 Zeus 控制器。 */
    additions: [['    "//chrome/browser/browseros/onboarding",', '\n    # Zeus 原生页面和桌面消息入口。\n    "//chrome/browser/ui/webui/zeus",']],
  },
  {
    /** Chrome 最终资源包的输入和依赖。 */
    path: 'chrome/chrome_paks.gni',
    /** 原始资源打包文件摘要。 */
    baseSha256: '80da784fb81c8cca9d3d38c8b2ffa63828d4b9e415bc1d6553e2c93099085755',
    /** BrowserOS 资源打包补丁摘要。 */
    patchSha256: '9cc512b536b78ed4f1b6fa4260b62a99a9b3b838accdc6cc46b3741c5b45f3ba',
    /** 资源内容和产生它的目标必须同时加入。 */
    additions: [
      ['        "$root_gen_dir/chrome/browseros_onboarding_resources.pak",', '\n        # 保留 Zeus 当前界面的完整静态资源。\n        "$root_gen_dir/chrome/zeus_resources.pak",'],
      ['        "//chrome/browser/browseros/onboarding:resources",', '\n        # 资源包生成必须先于合并步骤。\n        "//chrome/browser/ui/webui/zeus:resources",'],
    ],
  },
  {
    /** GRIT 资源身份的统一分配表。 */
    path: 'tools/gritsettings/resource_ids.spec',
    /** 原始资源身份文件摘要。 */
    baseSha256: 'dee816e323cedb6c2a458e152e1cef8e956a9c6a445165e1437545f3321e8007',
    /** BrowserOS 资源身份补丁摘要。 */
    patchSha256: 'bae93707c3549b36f63a3817ab3df3d53fa6fac2d9d67fbe509a68245a3a40b3',
    /** 2690 是排序标记；实际连续编号由 GRIT 按资源数分配。 */
    additions: [['    "includes": [2680],\n  },', '\n  # Zeus 的静态 GRD 提供实际资源数量。\n  "chrome/browser/ui/webui/zeus/resources/zeus_resources.grd": {\n    "includes": [2690],\n  },']],
  },
];
