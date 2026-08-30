/* 由冻结版本公开 api.json 机械生成；仅包含方法参数结构，不包含插件代码、文档正文或资产。 */
import type { BrowserFrozenArgumentSchema } from './browserFrozenContract.js';

export const browserFrozenPublicApiSha256 = '4bfeb97e958025db37d52aea11b75bc70bca417b4995b0f711c0f07f3ddccb08' as const;

export const browserFrozenUnsupportedSurfaces: Readonly<Record<string, readonly string[]>> = {
  'Browser.history': ['iab', 'cdp'],
  'BrowserUser.claimTab': ['cdp'],
  'Tabs.content': ['iab', 'extension', 'cdp'],
  'Tab.ax': ['iab', 'extension', 'cdp'],
  'Tab.markDeliverable': ['cdp'],
  'Tab.markHandoff': ['cdp'],
  'Tab.requestManualHandoff': ['extension', 'iab', 'cdp'],
  'CUAAPI.downloadMedia': ['iab'],
  'DomCUAAPI.downloadMedia': ['iab'],
};

export const browserFrozenPublicArgumentSchemas: Readonly<Record<string, BrowserFrozenArgumentSchema>> = {
  'Agent.browsers': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Agent.documentation': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Browsers.get': {
    type: 'object',
    properties: {
      id: {
        type: 'string',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  'Browsers.getDefault': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Browsers.getForUrl': {
    type: 'object',
    properties: {
      url: {
        type: 'string',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
  'Browsers.list': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Browser.browserId': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Browser.capabilities': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Browser.tabs': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Browser.user': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Browser.documentation': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Browser.history': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          from: {
            anyOf: [
              {
                type: 'string',
              },
              {},
            ],
          },
          limit: {
            type: 'number',
          },
          queries: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          to: {
            anyOf: [
              {
                type: 'string',
              },
              {},
            ],
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'Browser.nameSession': {
    type: 'object',
    properties: {
      name: {
        type: 'string',
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
  'BrowserUser.claimTab': {
    type: 'object',
    properties: {
      tab: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'object',
            properties: {
              id: {
                type: 'string',
              },
              lastOpened: {
                type: 'string',
              },
              providerTabId: {
                type: 'string',
              },
              tabGroup: {
                type: 'string',
              },
              title: {
                type: 'string',
              },
              url: {
                type: 'string',
              },
            },
            required: ['id'],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ['tab'],
    additionalProperties: false,
  },
  'BrowserUser.openTabs': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tabs.content': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          contentType: {
            type: 'string',
            enum: ['html', 'text', 'domSnapshot'],
          },
          timeoutMs: {
            type: 'number',
          },
          urls: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
        },
        required: ['contentType', 'urls'],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'Tabs.get': {
    type: 'object',
    properties: {
      id: {
        type: 'string',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  'Tabs.list': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tabs.new': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tabs.selected': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tab.ax': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tab.capabilities': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tab.clipboard': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tab.content': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tab.cua': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tab.dev': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tab.dom_cua': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tab.id': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tab.playwright': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tab.back': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tab.close': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tab.forward': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tab.getJsDialog': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tab.goto': {
    type: 'object',
    properties: {
      url: {
        type: 'string',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
  'Tab.markDeliverable': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tab.markHandoff': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tab.reload': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tab.requestManualHandoff': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tab.screenshot': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          clip: {
            type: 'object',
            properties: {
              height: {
                type: 'number',
              },
              width: {
                type: 'number',
              },
              x: {
                type: 'number',
              },
              y: {
                type: 'number',
              },
            },
            required: ['height', 'width', 'x', 'y'],
            additionalProperties: false,
          },
          fullPage: {
            type: 'boolean',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'Tab.title': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Tab.url': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'AXAPI.click': {
    type: 'object',
    properties: {
      target: {
        anyOf: [
          {
            type: 'number',
          },
          {
            type: 'array',
            prefixItems: [{}, {}],
            minItems: 2,
            maxItems: 2,
          },
        ],
      },
      options: {
        type: 'object',
        properties: {
          clickCount: {
            type: 'number',
          },
          mouseButton: {
            type: 'string',
            enum: ['left', 'right', 'middle', 'l', 'r', 'm'],
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['target'],
    additionalProperties: false,
  },
  'AXAPI.drag': {
    type: 'object',
    properties: {
      from: {
        type: 'array',
        prefixItems: [{}, {}],
        minItems: 2,
        maxItems: 2,
      },
      to: {
        type: 'array',
        prefixItems: [{}, {}],
        minItems: 2,
        maxItems: 2,
      },
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  'AXAPI.get': {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['state', 'screenshot', 'both'],
      },
      options: {
        type: 'object',
        properties: {
          disableDiffing: {
            type: 'boolean',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: [],
    additionalProperties: false,
  },
  'AXAPI.performSecondaryAction': {
    type: 'object',
    properties: {
      elementIndex: {
        type: 'number',
      },
      action: {
        type: 'string',
      },
    },
    required: ['elementIndex', 'action'],
    additionalProperties: false,
  },
  'AXAPI.pressKey': {
    type: 'object',
    properties: {
      key: {
        type: 'string',
      },
    },
    required: ['key'],
    additionalProperties: false,
  },
  'AXAPI.scroll': {
    type: 'object',
    properties: {
      target: {
        anyOf: [
          {
            type: 'number',
          },
          {
            type: 'array',
            prefixItems: [{}, {}],
            minItems: 2,
            maxItems: 2,
          },
        ],
      },
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right', 'u', 'd', 'l', 'r'],
      },
      pages: {
        type: 'number',
      },
    },
    required: ['target', 'direction'],
    additionalProperties: false,
  },
  'AXAPI.selectText': {
    type: 'object',
    properties: {
      elementIndex: {
        type: 'number',
      },
      text: {
        type: 'string',
      },
      options: {
        type: 'object',
        properties: {
          prefix: {
            type: 'string',
          },
          selectionType: {
            type: 'string',
            enum: ['text', 'cursor_before', 'cursor_after'],
          },
          suffix: {
            type: 'string',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['elementIndex', 'text'],
    additionalProperties: false,
  },
  'AXAPI.setValue': {
    type: 'object',
    properties: {
      elementIndex: {
        type: 'number',
      },
      value: {
        type: 'string',
      },
    },
    required: ['elementIndex', 'value'],
    additionalProperties: false,
  },
  'AXAPI.typeText': {
    type: 'object',
    properties: {
      text: {
        type: 'string',
      },
    },
    required: ['text'],
    additionalProperties: false,
  },
  'AXAPI.write': {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['state', 'screenshot', 'both'],
      },
      options: {
        type: 'object',
        properties: {
          disableDiffing: {
            type: 'boolean',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: [],
    additionalProperties: false,
  },
  'ContentAPI.export': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'ContentAPI.exportGsuite': {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['pdf', 'md', 'xlsx', 'csv', 'docx', 'pptx'],
      },
    },
    required: ['type'],
    additionalProperties: false,
  },
  'ContentAPI.exportYouTubeTranscript': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'CUAAPI.click': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          button: {
            type: 'number',
          },
          keypress: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          x: {
            type: 'number',
          },
          y: {
            type: 'number',
          },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'CUAAPI.double_click': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          keypress: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          x: {
            type: 'number',
          },
          y: {
            type: 'number',
          },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'CUAAPI.downloadMedia': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'number',
          },
          x: {
            type: 'number',
          },
          y: {
            type: 'number',
          },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'CUAAPI.drag': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          keys: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          path: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                x: {
                  type: 'number',
                },
                y: {
                  type: 'number',
                },
              },
              required: ['x', 'y'],
              additionalProperties: false,
            },
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'CUAAPI.keypress': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          keys: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
        },
        required: ['keys'],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'CUAAPI.move': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          keys: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          x: {
            type: 'number',
          },
          y: {
            type: 'number',
          },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'CUAAPI.scroll': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          keypress: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          scrollX: {
            type: 'number',
          },
          scrollY: {
            type: 'number',
          },
          x: {
            type: 'number',
          },
          y: {
            type: 'number',
          },
        },
        required: ['scrollX', 'scrollY', 'x', 'y'],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'CUAAPI.type': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'DomCUAAPI.click': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          node_id: {
            type: 'string',
          },
        },
        required: ['node_id'],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'DomCUAAPI.double_click': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          node_id: {
            type: 'string',
          },
        },
        required: ['node_id'],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'DomCUAAPI.downloadMedia': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          node_id: {
            type: 'string',
          },
          timeoutMs: {
            type: 'number',
          },
        },
        required: ['node_id'],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'DomCUAAPI.get_visible_dom': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'DomCUAAPI.keypress': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          keys: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
        },
        required: ['keys'],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'DomCUAAPI.scroll': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          node_id: {
            type: 'string',
          },
          x: {
            type: 'number',
          },
          y: {
            type: 'number',
          },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'DomCUAAPI.type': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'PlaywrightAPI.domSnapshot': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'PlaywrightAPI.elementInfo': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          includeNonInteractable: {
            type: 'boolean',
          },
          x: {
            type: 'number',
          },
          y: {
            type: 'number',
          },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'PlaywrightAPI.elementScreenshot': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          includeNonInteractable: {
            type: 'boolean',
          },
          x: {
            type: 'number',
          },
          y: {
            type: 'number',
          },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'PlaywrightAPI.evaluate': {
    type: 'object',
    properties: {
      pageFunction: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'object',
            additionalProperties: true,
            description: 'Zeus frozen action descriptor.',
          },
        ],
      },
      arg: {},
      options: {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['pageFunction'],
    additionalProperties: false,
  },
  'PlaywrightAPI.expectNavigation': {
    type: 'object',
    properties: {
      action: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
          },
          handle: {
            type: 'string',
          },
          arguments: {
            type: 'object',
            additionalProperties: true,
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      options: {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'number',
          },
          url: {
            type: 'string',
          },
          waitUntil: {
            type: 'string',
            enum: ['load', 'domcontentloaded', 'networkidle'],
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['action', 'options'],
    additionalProperties: false,
  },
  'PlaywrightAPI.frameLocator': {
    type: 'object',
    properties: {
      frameSelector: {
        type: 'string',
      },
    },
    required: ['frameSelector'],
    additionalProperties: false,
  },
  'PlaywrightAPI.getByLabel': {
    type: 'object',
    properties: {
      text: {
        anyOf: [
          {
            type: 'string',
          },
          {},
        ],
      },
      options: {
        type: 'object',
        properties: {
          exact: {
            type: 'boolean',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['text', 'options'],
    additionalProperties: false,
  },
  'PlaywrightAPI.getByPlaceholder': {
    type: 'object',
    properties: {
      text: {
        anyOf: [
          {
            type: 'string',
          },
          {},
        ],
      },
      options: {
        type: 'object',
        properties: {
          exact: {
            type: 'boolean',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['text', 'options'],
    additionalProperties: false,
  },
  'PlaywrightAPI.getByRole': {
    type: 'object',
    properties: {
      role: {
        type: 'string',
      },
      options: {
        type: 'object',
        properties: {
          exact: {
            type: 'boolean',
          },
          name: {
            anyOf: [
              {
                type: 'string',
              },
              {},
            ],
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['role', 'options'],
    additionalProperties: false,
  },
  'PlaywrightAPI.getByTestId': {
    type: 'object',
    properties: {
      testId: {
        type: 'string',
      },
    },
    required: ['testId'],
    additionalProperties: false,
  },
  'PlaywrightAPI.getByText': {
    type: 'object',
    properties: {
      text: {
        anyOf: [
          {
            type: 'string',
          },
          {},
        ],
      },
      options: {
        type: 'object',
        properties: {
          exact: {
            type: 'boolean',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['text', 'options'],
    additionalProperties: false,
  },
  'PlaywrightAPI.locator': {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
      },
    },
    required: ['selector'],
    additionalProperties: false,
  },
  'PlaywrightAPI.waitForEvent': {
    type: 'object',
    properties: {
      event: {
        type: 'string',
        enum: ['download', 'filechooser'],
      },
      options: {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['event'],
    additionalProperties: false,
  },
  'PlaywrightAPI.waitForLoadState': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            enum: ['load', 'domcontentloaded', 'networkidle'],
          },
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'PlaywrightAPI.waitForTimeout': {
    type: 'object',
    properties: {
      timeoutMs: {
        type: 'number',
      },
    },
    required: ['timeoutMs'],
    additionalProperties: false,
  },
  'PlaywrightAPI.waitForURL': {
    type: 'object',
    properties: {
      url: {
        type: 'string',
      },
      options: {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'number',
          },
          waitUntil: {
            type: 'string',
            enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['url', 'options'],
    additionalProperties: false,
  },
  'PlaywrightFrameLocator.frameLocator': {
    type: 'object',
    properties: {
      frameSelector: {
        type: 'string',
      },
    },
    required: ['frameSelector'],
    additionalProperties: false,
  },
  'PlaywrightFrameLocator.getByLabel': {
    type: 'object',
    properties: {
      text: {
        anyOf: [
          {
            type: 'string',
          },
          {},
        ],
      },
      options: {
        type: 'object',
        properties: {
          exact: {
            type: 'boolean',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['text', 'options'],
    additionalProperties: false,
  },
  'PlaywrightFrameLocator.getByPlaceholder': {
    type: 'object',
    properties: {
      text: {
        anyOf: [
          {
            type: 'string',
          },
          {},
        ],
      },
      options: {
        type: 'object',
        properties: {
          exact: {
            type: 'boolean',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['text', 'options'],
    additionalProperties: false,
  },
  'PlaywrightFrameLocator.getByRole': {
    type: 'object',
    properties: {
      role: {
        type: 'string',
      },
      options: {
        type: 'object',
        properties: {
          exact: {
            type: 'boolean',
          },
          name: {
            anyOf: [
              {
                type: 'string',
              },
              {},
            ],
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['role', 'options'],
    additionalProperties: false,
  },
  'PlaywrightFrameLocator.getByTestId': {
    type: 'object',
    properties: {
      testId: {
        type: 'string',
      },
    },
    required: ['testId'],
    additionalProperties: false,
  },
  'PlaywrightFrameLocator.getByText': {
    type: 'object',
    properties: {
      text: {
        anyOf: [
          {
            type: 'string',
          },
          {},
        ],
      },
      options: {
        type: 'object',
        properties: {
          exact: {
            type: 'boolean',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['text', 'options'],
    additionalProperties: false,
  },
  'PlaywrightFrameLocator.locator': {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
      },
    },
    required: ['selector'],
    additionalProperties: false,
  },
  'PlaywrightLocator.all': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'PlaywrightLocator.allTextContents': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'PlaywrightLocator.and': {
    type: 'object',
    properties: {
      locator: {
        type: 'string',
        description: 'Current-turn Zeus Browser handle.',
      },
    },
    required: ['locator'],
    additionalProperties: false,
  },
  'PlaywrightLocator.check': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          force: {
            type: 'boolean',
          },
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'PlaywrightLocator.click': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          button: {
            type: 'string',
            enum: ['left', 'right', 'middle'],
          },
          force: {
            type: 'boolean',
          },
          modifiers: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'],
            },
          },
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'PlaywrightLocator.count': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'PlaywrightLocator.dblclick': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          button: {
            type: 'string',
            enum: ['left', 'right', 'middle'],
          },
          force: {
            type: 'boolean',
          },
          modifiers: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'],
            },
          },
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'PlaywrightLocator.downloadMedia': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'PlaywrightLocator.evaluate': {
    type: 'object',
    properties: {
      pageFunction: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'object',
            additionalProperties: true,
            description: 'Zeus frozen action descriptor.',
          },
        ],
      },
      arg: {},
      options: {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['pageFunction'],
    additionalProperties: false,
  },
  'PlaywrightLocator.evaluateAll': {
    type: 'object',
    properties: {
      pageFunction: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'object',
            additionalProperties: true,
            description: 'Zeus frozen action descriptor.',
          },
        ],
      },
      arg: {},
      options: {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['pageFunction'],
    additionalProperties: false,
  },
  'PlaywrightLocator.fill': {
    type: 'object',
    properties: {
      value: {
        type: 'string',
      },
      options: {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['value', 'options'],
    additionalProperties: false,
  },
  'PlaywrightLocator.filter': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          has: {
            type: 'string',
            description: 'Current-turn Zeus Browser handle.',
          },
          hasNot: {
            type: 'string',
            description: 'Current-turn Zeus Browser handle.',
          },
          hasNotText: {
            anyOf: [
              {
                type: 'string',
              },
              {},
            ],
          },
          hasText: {
            anyOf: [
              {
                type: 'string',
              },
              {},
            ],
          },
          visible: {
            type: 'boolean',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'PlaywrightLocator.first': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'PlaywrightLocator.getAttribute': {
    type: 'object',
    properties: {
      name: {
        type: 'string',
      },
      options: {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['name', 'options'],
    additionalProperties: false,
  },
  'PlaywrightLocator.getByLabel': {
    type: 'object',
    properties: {
      text: {
        anyOf: [
          {
            type: 'string',
          },
          {},
        ],
      },
      options: {
        type: 'object',
        properties: {
          exact: {
            type: 'boolean',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['text', 'options'],
    additionalProperties: false,
  },
  'PlaywrightLocator.getByPlaceholder': {
    type: 'object',
    properties: {
      text: {
        anyOf: [
          {
            type: 'string',
          },
          {},
        ],
      },
      options: {
        type: 'object',
        properties: {
          exact: {
            type: 'boolean',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['text', 'options'],
    additionalProperties: false,
  },
  'PlaywrightLocator.getByRole': {
    type: 'object',
    properties: {
      role: {
        type: 'string',
      },
      options: {
        type: 'object',
        properties: {
          exact: {
            type: 'boolean',
          },
          name: {
            anyOf: [
              {
                type: 'string',
              },
              {},
            ],
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['role', 'options'],
    additionalProperties: false,
  },
  'PlaywrightLocator.getByTestId': {
    type: 'object',
    properties: {
      testId: {
        type: 'string',
      },
    },
    required: ['testId'],
    additionalProperties: false,
  },
  'PlaywrightLocator.getByText': {
    type: 'object',
    properties: {
      text: {
        anyOf: [
          {
            type: 'string',
          },
          {},
        ],
      },
      options: {
        type: 'object',
        properties: {
          exact: {
            type: 'boolean',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['text', 'options'],
    additionalProperties: false,
  },
  'PlaywrightLocator.innerText': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'PlaywrightLocator.isEnabled': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'PlaywrightLocator.isVisible': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'PlaywrightLocator.last': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'PlaywrightLocator.locator': {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
      },
      options: {
        type: 'object',
        properties: {
          has: {
            type: 'string',
            description: 'Current-turn Zeus Browser handle.',
          },
          hasNot: {
            type: 'string',
            description: 'Current-turn Zeus Browser handle.',
          },
          hasNotText: {
            anyOf: [
              {
                type: 'string',
              },
              {},
            ],
          },
          hasText: {
            anyOf: [
              {
                type: 'string',
              },
              {},
            ],
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['selector', 'options'],
    additionalProperties: false,
  },
  'PlaywrightLocator.nth': {
    type: 'object',
    properties: {
      index: {
        type: 'number',
      },
    },
    required: ['index'],
    additionalProperties: false,
  },
  'PlaywrightLocator.or': {
    type: 'object',
    properties: {
      locator: {
        type: 'string',
        description: 'Current-turn Zeus Browser handle.',
      },
    },
    required: ['locator'],
    additionalProperties: false,
  },
  'PlaywrightLocator.press': {
    type: 'object',
    properties: {
      value: {
        type: 'string',
      },
      options: {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['value', 'options'],
    additionalProperties: false,
  },
  'PlaywrightLocator.pressSequentially': {
    type: 'object',
    properties: {
      value: {
        type: 'string',
      },
      options: {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['value', 'options'],
    additionalProperties: false,
  },
  'PlaywrightLocator.selectOption': {
    type: 'object',
    properties: {
      value: {
        anyOf: [
          {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'object',
                properties: {
                  index: {
                    type: 'number',
                  },
                  label: {
                    type: 'string',
                  },
                  value: {
                    type: 'string',
                  },
                },
                required: [],
                additionalProperties: false,
              },
            ],
          },
          {
            type: 'array',
            items: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'object',
                  properties: {
                    index: {
                      type: 'number',
                    },
                    label: {
                      type: 'string',
                    },
                    value: {
                      type: 'string',
                    },
                  },
                  required: [],
                  additionalProperties: false,
                },
              ],
            },
          },
        ],
      },
      options: {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['value', 'options'],
    additionalProperties: false,
  },
  'PlaywrightLocator.setChecked': {
    type: 'object',
    properties: {
      checked: {
        type: 'boolean',
      },
      options: {
        type: 'object',
        properties: {
          force: {
            type: 'boolean',
          },
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['checked', 'options'],
    additionalProperties: false,
  },
  'PlaywrightLocator.textContent': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'PlaywrightLocator.type': {
    type: 'object',
    properties: {
      value: {
        type: 'string',
      },
      options: {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['value', 'options'],
    additionalProperties: false,
  },
  'PlaywrightLocator.uncheck': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          force: {
            type: 'boolean',
          },
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'PlaywrightLocator.waitFor': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            enum: ['attached', 'detached', 'visible', 'hidden'],
          },
          timeoutMs: {
            type: 'number',
          },
        },
        required: ['state'],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'PlaywrightDownload.path': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'PlaywrightFileChooser.isMultiple': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'PlaywrightFileChooser.setFiles': {
    type: 'object',
    properties: {
      files: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'array',
            items: {
              type: 'string',
            },
          },
        ],
      },
      options: {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['files', 'options'],
    additionalProperties: false,
  },
  'TabClipboardAPI.read': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'TabClipboardAPI.readText': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'TabClipboardAPI.write': {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            entries: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  base64: {
                    type: 'string',
                  },
                  mimeType: {
                    type: 'string',
                  },
                  text: {
                    type: 'string',
                  },
                },
                required: ['mimeType'],
                additionalProperties: false,
              },
            },
            presentationStyle: {
              type: 'string',
              enum: ['unspecified', 'inline', 'attachment'],
            },
          },
          required: ['entries'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  },
  'TabClipboardAPI.writeText': {
    type: 'object',
    properties: {
      text: {
        type: 'string',
      },
    },
    required: ['text'],
    additionalProperties: false,
  },
  'TabDevAPI.logs': {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
          },
          levels: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['debug', 'info', 'log', 'warn', 'error', 'warning'],
            },
          },
          limit: {
            type: 'number',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
  'AlertDialog.type': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'AlertDialog.dismiss': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'BeforeUnloadDialog.type': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'BeforeUnloadDialog.dismiss': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'ConfirmDialog.type': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'ConfirmDialog.accept': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'ConfirmDialog.dismiss': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'Documentation.get': {
    type: 'object',
    properties: {
      name: {
        type: 'string',
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
  'PromptDialog.type': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  'PromptDialog.accept': {
    type: 'object',
    properties: {
      text: {
        type: 'string',
      },
    },
    required: ['text'],
    additionalProperties: false,
  },
  'PromptDialog.dismiss': {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
};
