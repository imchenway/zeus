import { digitalEmployeeAvatarIds, type DigitalEmployeeAvatarId } from '@zeus/shared';
/** 由构建器解析的本地头像地址。 */
const loki = new URL('../../assets/digital-employees/loki.png', import.meta.url).href;
/** 由构建器解析的本地头像地址。 */
const argus = new URL('../../assets/digital-employees/argus.png', import.meta.url).href;
/** 由构建器解析的本地头像地址。 */
const eric = new URL('../../assets/digital-employees/eric.png', import.meta.url).href;
/** 由构建器解析的本地头像地址。 */
const higgins = new URL('../../assets/digital-employees/higgins.png', import.meta.url).href;
/** 由构建器解析的本地头像地址。 */
const vidar = new URL('../../assets/digital-employees/vidar.png', import.meta.url).href;

/** 随应用分发的头像资源，不在运行时访问外部图片。 */
const portraits = { loki, argus, eric, higgins, vidar };
/** 旧记录未选择头像时，按内置岗位使用固定默认值。 */
export function employeeAvatarId(record: { avatarId?: DigitalEmployeeAvatarId | null; role: string }): DigitalEmployeeAvatarId {
  return record.avatarId ?? ({ 产品: 'higgins', 前端: 'eric', 开发: 'loki', 测试: 'vidar', 部署: 'argus' } as Record<string, DigitalEmployeeAvatarId>)[record.role] ?? 'loki';
}
/** 模板与项目员工共用头像。文字名称由邻近内容提供。 */
export function DigitalEmployeeAvatar(props: { avatarId?: DigitalEmployeeAvatarId | null; role: string }) {
  return <img className="digital-employee-avatar" src={portraits[employeeAvatarId(props)]} alt="" />;
}
/** 预置头像单选，内置模板也允许修改外观。 */
export function EmployeeAvatarPicker(props: { avatarId?: DigitalEmployeeAvatarId | null; role: string; disabled: boolean; onChange: (id: DigitalEmployeeAvatarId) => void; language: 'zh-CN' | 'en-US' }) {
  return (
    <div className="employee-avatar-options" role="group" aria-label={props.language === 'zh-CN' ? '预置头像' : 'Preset portraits'}>
      {digitalEmployeeAvatarIds.map((id) => (
        <button key={id} type="button" className="employee-avatar-option" aria-label={id} title={id} aria-pressed={employeeAvatarId(props) === id} disabled={props.disabled} onClick={() => props.onChange(id)}>
          <img src={portraits[id]} alt="" />
        </button>
      ))}
    </div>
  );
}
