import { localParts } from './automationTime.js';

/** 一种计费项使用明确的计量名和单位，价格对应 quantityPerPrice 个该单位。 */
export interface MeteredCharge {
  meter: string;
  unit: string;
  quantityPerPrice: number;
  /** 未确认该项费率时，只接受明确为零的观测数量。 */
  amount: number | null;
  /** 以账本已有的输入、输出与请求费用类别显示。 */
  category: 'input' | 'output' | 'perRequest';
}

/** 计费适用条件。结束时间及每个时段的结束分钟均为开区间。 */
export interface MeteredPrice {
  charges: MeteredCharge[];
  /** 官方费率生效和失效时间，必须带时区。 */
  validFrom?: string;
  validUntil?: string;
  /** 地域、分组、服务档位等由回执或实际路由提供的相等条件。 */
  attributes?: Record<string, string>;
  /** 任一窗口匹配即可使用，跨午夜费率可用两个窗口表示。 */
  windows?: Array<{ timeZone: string; weekdays: number[]; startMinute: number; endMinute: number }>;
}

/** 一次请求的已观测计量。空项不表示零。 */
export interface MeteredUsage {
  quantities: Array<{ meter: string; unit: string; quantity: number }>;
  attributes?: Record<string, string>;
}

/** 价目及回执使用的标识符和字段键不接受路径或原型名称。 */
export function isPricingIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u.test(value) && !Object.hasOwn(Object.prototype, value);
}

/** 只允许非凭据字段成为公开价目的请求条件。 */
export function isPricingAttribute(value: unknown): value is string {
  return isPricingIdentifier(value) && !/token|secret|authorization|credential|password|passphrase|bearer|cookie|key$/iu.test(value.replace(/[^a-z0-9]/giu, ''));
}

/** 计量与价目金额使用有限的非负数，明确的零保留。 */
export function isPricingAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** 回执与费率配置只读取 JSON 对象字段。 */
function pricingRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 生效时间必须携带时间偏移，避免同一价目在不同机器上产生两种结果。 */
function isPricingInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const day = value.slice(0, 10);
  return new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}

/** 存储和网络共用计费项校验，同一计量项只能出现一次。 */
export function isMeteredPrice(value: unknown): value is MeteredPrice {
  const price = pricingRecord(value);
  if (Object.keys(price).some((key) => !['charges', 'validFrom', 'validUntil', 'attributes', 'windows'].includes(key))) return false;
  if (!Array.isArray(price.charges) || !price.charges.length || price.charges.length > 32) return false;
  const meters = new Set<string>();
  for (const entry of price.charges) {
    const charge = pricingRecord(entry);
    if (Object.keys(charge).some((key) => !['meter', 'unit', 'quantityPerPrice', 'amount', 'category'].includes(key))) return false;
    if (!isPricingIdentifier(charge.meter) || !isPricingIdentifier(charge.unit) || (charge.amount !== null && !isPricingAmount(charge.amount)) || !isPricingAmount(charge.quantityPerPrice) || charge.quantityPerPrice === 0) return false;
    if (charge.category !== 'input' && charge.category !== 'output' && charge.category !== 'perRequest') return false;
    if (meters.has(charge.meter)) return false;
    meters.add(charge.meter);
  }
  if (price.validFrom !== undefined && !isPricingInstant(price.validFrom)) return false;
  if (price.validUntil !== undefined && !isPricingInstant(price.validUntil)) return false;
  if (typeof price.validFrom === 'string' && typeof price.validUntil === 'string' && Date.parse(price.validFrom) >= Date.parse(price.validUntil)) return false;
  if (
    price.attributes !== undefined &&
    (!price.attributes ||
      typeof price.attributes !== 'object' ||
      Array.isArray(price.attributes) ||
      Object.entries(price.attributes).some(([key, value]) => !isPricingAttribute(key) || typeof value !== 'string' || !value.trim() || value.length > 256))
  )
    return false;
  if (price.windows === undefined) return true;
  return (
    Array.isArray(price.windows) &&
    price.windows.length > 0 &&
    price.windows.length <= 32 &&
    price.windows.every((entry) => {
      const window = pricingRecord(entry);
      if (Object.keys(window).some((key) => !['timeZone', 'weekdays', 'startMinute', 'endMinute'].includes(key))) return false;
      if (typeof window.timeZone !== 'string' || !window.timeZone || !Array.isArray(window.weekdays) || !window.weekdays.length) return false;
      if (window.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) return false;
      if (!isPricingAmount(window.startMinute) || !isPricingAmount(window.endMinute) || !Number.isInteger(window.startMinute) || !Number.isInteger(window.endMinute) || window.startMinute >= window.endMinute || window.endMinute > 1440)
        return false;
      try {
        new Intl.DateTimeFormat('en', { timeZone: window.timeZone });
        return true;
      } catch {
        return false;
      }
    })
  );
}

/** 缺失维度返回 unknown，无法裁定的较贵规则不能被普通费率掩盖。 */
export function matchMeteredPrice(price: MeteredPrice, usage: MeteredUsage | undefined, at: string, catalogAt: string, historical: boolean): boolean | 'unknown' {
  const instant = Date.parse(at);
  if (!Number.isFinite(instant)) return 'unknown';
  if (price.validUntil && instant >= Date.parse(price.validUntil)) return false;
  if (price.validFrom && instant < Date.parse(price.validFrom)) return false;
  if (historical && !price.validFrom && !(instant >= Date.parse(catalogAt))) return 'unknown';
  if (
    price.windows &&
    !price.windows.some((window) => {
      const local = localParts(new Date(instant), window.timeZone);
      const minute = local.hour * 60 + local.minute;
      const day = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
      return window.weekdays.includes(day) && minute >= window.startMinute && minute < window.endMinute;
    })
  )
    return false;
  const attributes = usage?.attributes ?? {};
  const required = Object.entries(price.attributes ?? {});
  if (required.some(([key, value]) => Object.hasOwn(attributes, key) && attributes[key] !== value)) return false;
  return required.some(([key]) => !Object.hasOwn(attributes, key)) ? 'unknown' : true;
}

/** 唯一的计算方式为实际数量乘规模单价，单位不匹配及缺量都返回空。 */
export function meteredChargeAmounts(price: MeteredPrice, usage: MeteredUsage | undefined): Array<{ category: MeteredCharge['category']; amount: number }> | null {
  const amounts: Array<{ category: MeteredCharge['category']; amount: number }> = [];
  for (const charge of price.charges) {
    const observations = usage?.quantities.filter((quantity) => quantity.meter === charge.meter) ?? [];
    const observation = observations[0];
    if (observations.length !== 1 || !observation || observation.unit !== charge.unit || !isPricingAmount(observation.quantity)) return null;
    if (charge.amount === null && observation.quantity > 0) return null;
    const amount = (observation.quantity / charge.quantityPerPrice) * (charge.amount ?? 0);
    if (!Number.isFinite(amount)) return null;
    amounts.push({ category: charge.category, amount });
  }
  return amounts;
}
