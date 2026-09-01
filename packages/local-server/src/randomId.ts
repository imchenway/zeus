import {randomBytes} from 'node:crypto';

/** 生成定长 URL 安全随机标识。 */
export function randomId(length: number): string {
    return randomBytes(length).toString('base64url').slice(0, length);
}
