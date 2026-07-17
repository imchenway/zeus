import { Buffer } from 'node:buffer';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const response = Buffer.from('{"id":7,"result":{"ok":"好"}}\r\n');
const chineseByte = response.indexOf(Buffer.from('好'));

process.stdout.write(response.subarray(0, chineseByte + 1));
process.stderr.write('{"method":"stderr/diagnostic","params":{"mustNotDecode":true}}\n');

setTimeout(() => {
  process.stdout.write(response.subarray(chineseByte + 1));
  process.stdout.write('{"method":"thread/started","params":{"threadId":"thread-fixture"}}\n');
}, 10);
