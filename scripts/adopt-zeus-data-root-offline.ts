#!/usr/bin/env node

interface ParsedArguments {
  mode: 'plan' | 'apply';
  dataRoot: string;
  profile: 'production' | 'test';
  distributionLabel: string;
  confirmationToken?: string;
}

const usage = `用法：
  pnpm data-root:adopt-offline -- --data-root /absolute/path/to/root --profile production --distribution-label dev.hypha.zeus --plan
  pnpm data-root:adopt-offline -- --data-root /absolute/path/to/root --profile production --distribution-label dev.hypha.zeus --confirm-token <plan 输出的 confirmationToken>

Test 必须逐字使用 --profile test --distribution-label dev.hypha.zeus.test。
脚本没有默认数据根；未提供全部参数时不会查找或读取任何 Zeus 数据目录。
`;

if (process.argv.length === 2) {
  process.stderr.write(usage);
  process.exitCode = 2;
} else if (process.argv.includes('--help')) {
  process.stdout.write(usage);
} else {
  try {
    const parsed = parseArguments(process.argv.slice(2));
    const { adoptZeusDataRootOffline, planZeusDataRootOfflineAdoption, zeusDataRootHostIdentity } = await import('../apps/desktop/src/main/dataRootIdentity.js');
    const request = {
      rootPath: parsed.dataRoot,
      profile: parsed.profile,
      distributionLabel: parsed.distributionLabel,
    } as const;
    if (parsed.mode === 'plan') {
      const plan = planZeusDataRootOfflineAdoption(request);
      process.stdout.write(`${JSON.stringify({ status: 'confirmation-required', plan }, null, 2)}\n`);
    } else {
      const marker = adoptZeusDataRootOffline({ ...request, confirmationToken: parsed.confirmationToken! });
      process.stdout.write(
        `${JSON.stringify(
          {
            status: 'adopted',
            markerPath: `${marker.canonicalRoot}/.zeus-root-identity.json`,
            markerMode: '0600',
            dataRootIdentity: zeusDataRootHostIdentity(marker),
          },
          null,
          2,
        )}\n`,
      );
    }
  } catch (error) {
    const detail = {
      status: 'rejected',
      code: error instanceof Error && 'code' in error ? String(error.code) : 'ZEUS_DATA_ROOT_OFFLINE_ADOPTION_FAILED',
      message: error instanceof Error ? error.message : String(error),
      failClosed: true,
    };
    process.stderr.write(`${JSON.stringify(detail, null, 2)}\n`);
    process.exitCode = 1;
  }
}

function parseArguments(argumentsList: readonly string[]): ParsedArguments {
  const values = new Map<string, string>();
  let plan = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]!;
    if (index === 0 && argument === '--') continue;
    if (argument === '--plan') {
      if (plan) throw cliError('ZEUS_DATA_ROOT_OFFLINE_ARGUMENT_DUPLICATE', '--plan 只能出现一次。');
      plan = true;
      continue;
    }
    if (!['--data-root', '--profile', '--distribution-label', '--confirm-token'].includes(argument)) {
      throw cliError('ZEUS_DATA_ROOT_OFFLINE_ARGUMENT_UNKNOWN', `未知参数：${argument}`);
    }
    if (values.has(argument)) throw cliError('ZEUS_DATA_ROOT_OFFLINE_ARGUMENT_DUPLICATE', `参数重复：${argument}`);
    const value = argumentsList[index + 1];
    if (!value || value.startsWith('--')) throw cliError('ZEUS_DATA_ROOT_OFFLINE_ARGUMENT_MISSING', `参数缺少值：${argument}`);
    values.set(argument, value);
    index += 1;
  }

  const dataRoot = requireArgument(values, '--data-root');
  const profile = requireArgument(values, '--profile');
  const distributionLabel = requireArgument(values, '--distribution-label');
  if (profile !== 'production' && profile !== 'test') {
    throw cliError('ZEUS_DATA_ROOT_OFFLINE_PROFILE_INVALID', '--profile 只能逐字使用 production 或 test。');
  }
  const confirmationToken = values.get('--confirm-token');
  if (plan === Boolean(confirmationToken)) {
    throw cliError('ZEUS_DATA_ROOT_OFFLINE_CONFIRMATION_MODE_INVALID', '必须且只能选择 --plan 或 --confirm-token。');
  }
  if (confirmationToken && !/^[0-9a-f]{64}$/u.test(confirmationToken)) {
    throw cliError('ZEUS_DATA_ROOT_OFFLINE_CONFIRMATION_INVALID', '--confirm-token 必须是 plan 输出的 64 位小写 SHA-256。');
  }
  return {
    mode: plan ? 'plan' : 'apply',
    dataRoot,
    profile,
    distributionLabel,
    ...(confirmationToken ? { confirmationToken } : {}),
  };
}

function requireArgument(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name)?.trim();
  if (!value) throw cliError('ZEUS_DATA_ROOT_OFFLINE_ARGUMENT_MISSING', `缺少必填参数：${name}`);
  return value;
}

function cliError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, failClosed: true as const });
}
