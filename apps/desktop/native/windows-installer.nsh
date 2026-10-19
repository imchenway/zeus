; Windows 安装器扩展：复用 NSIS 文件安装，只接管安全退出和结果回执。
!include "FileFunc.nsh"

; 按目标可执行文件的完整路径识别应用；返回 0 为运行中、1 为未运行、2 为无法确认。
; 路径只通过当前安装进程的环境传入，中文、空格、单引号及命令字符不进入脚本源码。
!define ZEUS_CHECK_APP_PROCESS `try { $$target = $$env:ZEUS_INSTALLER_TARGET; if ([string]::IsNullOrWhiteSpace($$target)) { exit 2 }; foreach ($$entry in (Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object Name -eq ([IO.Path]::GetFileName($$target)))) { if ([string]::IsNullOrWhiteSpace($$entry.ExecutablePath)) { exit 2 }; if ([string]::Equals($$entry.ExecutablePath, $$target, [StringComparison]::OrdinalIgnoreCase)) { exit 0 } }; exit 1 } catch { exit 2 }`

; 事务回执只属于安装器；卸载器没有升级事务，也不声明相应变量。
!ifndef BUILD_UNINSTALLER
; 当前升级事务的结果路径，首次安装时为空。
Var ZeusResult
; 当前升级的随机身份，由正在运行的应用生成。
Var ZeusTransaction
; 已打开的旧主进程句柄，不通过 PID 轮询猜测进程是否更换。
Var ZeusMainHandle

; 只写固定状态和已经由应用生成的事务身份，不把用户文本拼接进 JSON。
!macro ZeusWriteStatus STATUS
  ${If} $ZeusResult != ""
    FileOpen $R8 "$ZeusResult.partial" w
    FileWrite $R8 '{$\"transactionId$\":$\"$ZeusTransaction$\",$\"status$\":$\"${STATUS}$\"}'
    FileClose $R8
    Delete "$ZeusResult"
    Rename "$ZeusResult.partial" "$ZeusResult"
  ${EndIf}
!macroend
!endif

; 安装和卸载共用路径检查，同名安装程序或其他目录中的应用不占用当前安装。
!macro customCheckAppRunning
  StrCpy $R0 2
  System::Call 'kernel32::SetEnvironmentVariableW(w "ZEUS_INSTALLER_TARGET", w "$INSTDIR\${APP_EXECUTABLE_FILENAME}") i.r0'
  ${If} $0 != 0
    ; 复用 Windows 自带的 PowerShell/CIM；查询失败或超时必须停止，不能按未运行放行。
    nsExec::Exec /TIMEOUT=15000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "${ZEUS_CHECK_APP_PROCESS}"`
    Pop $R0
    System::Call 'kernel32::SetEnvironmentVariableW(w "ZEUS_INSTALLER_TARGET", p 0)'
  ${EndIf}
  ${If} $R0 != 1
    !ifndef BUILD_UNINSTALLER
    !insertmacro ZeusWriteStatus "failed"
    !endif
    ${If} $R0 == 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "${PRODUCT_NAME} 仍在运行。请在 ${PRODUCT_NAME} 中停止工作并退出，再运行安装器。" /SD IDOK
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "无法确认 ${PRODUCT_NAME} 是否已退出，安装或卸载已停止。请确认系统 PowerShell 和 WMI 可用后重试。" /SD IDOK
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

; 安装专用钩子不进入独立卸载器的编译单元。
!ifndef BUILD_UNINSTALLER
; 显式升级先核验旧主进程所在路径，再等待完整退出且退出码为零。
!macro customInit
  ; 产品安装门禁为 Windows 10 22H2 的 19045；Windows 11 的具体兼容构建仍由实机验收确认。
  ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  ${If} $R0 < 19045
    MessageBox MB_OK|MB_ICONEXCLAMATION "Zeus requires Windows 10 22H2 (build 19045) or Windows 11. / Zeus 需要 Windows 10 22H2（构建 19045）或 Windows 11。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${GetParameters} $R0
  ${GetOptions} $R0 "/ZEUS-PID=" $R1
  ${IfNot} ${Errors}
    ${GetOptions} $R0 "/ZEUS-RESULT=" $ZeusResult
    ${GetOptions} $R0 "/ZEUS-TRANSACTION=" $ZeusTransaction
    ${GetOptions} $R0 "/ZEUS-TARGET=" $R2
    ${If} $ZeusResult == ""
    ${OrIf} $ZeusTransaction == ""
      SetErrorLevel 2
      Quit
    ${EndIf}
    System::Call 'kernel32::OpenProcess(i 0x101000, i 0, i $R1) p.r0'
    StrCpy $ZeusMainHandle $0
    ${If} $ZeusMainHandle == 0
      !insertmacro ZeusWriteStatus "failed"
      SetErrorLevel 2
      Quit
    ${EndIf}
    System::Call 'kernel32::QueryFullProcessImageNameW(p $ZeusMainHandle, i 0, w .r1, *i ${NSIS_MAX_STRLEN}) i.r3'
    ${If} $3 == 0
    ${OrIf} $1 != $R2
    ${OrIf} $1 != "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      !insertmacro ZeusWriteStatus "failed"
      System::Call 'kernel32::CloseHandle(p $ZeusMainHandle)'
      SetErrorLevel 2
      Quit
    ${EndIf}
    !insertmacro ZeusWriteStatus "ready"
    ; 等待真实句柄期间也处理撤销，旧事务不能长期持有安装器互斥锁。
    StrCpy $R4 0
    ZeusWaitForMain:
      ${If} ${FileExists} "$ZeusResult.cancel"
        !insertmacro ZeusWriteStatus "cancelled"
        System::Call 'kernel32::CloseHandle(p $ZeusMainHandle)'
        SetErrorLevel 2
        Quit
      ${EndIf}
      System::Call 'kernel32::WaitForSingleObject(p $ZeusMainHandle, i 200) i.r0'
      IntOp $R4 $R4 + 1
      ${If} $0 == 258
      ${AndIf} $R4 < 3000
        Goto ZeusWaitForMain
      ${EndIf}
    System::Call 'kernel32::GetExitCodeProcess(p $ZeusMainHandle, *i .r1) i.r2'
    System::Call 'kernel32::CloseHandle(p $ZeusMainHandle)'
    ${If} $0 != 0
    ${OrIf} $2 == 0
    ${OrIf} $1 != 0
      !insertmacro ZeusWriteStatus "failed"
      SetErrorLevel 2
      Quit
    ${EndIf}
    ; 取消标记单独持久化，迟到的 ready 回执不能覆盖用户取消。
    ${If} ${FileExists} "$ZeusResult.cancel"
      SetErrorLevel 2
      Quit
    ${EndIf}
    ; 主程序取消或启动结果未知时会撤销回执，旧安装器不能在未来退出时继续安装。
    FileOpen $R8 "$ZeusResult" r
    FileRead $R8 $R9
    FileClose $R8
    ${If} $R9 != '{$\"transactionId$\":$\"$ZeusTransaction$\",$\"status$\":$\"ready$\"}'
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
!macroend

; 缓存路径来自 electron-builder 自己的安装器缓存，供下次升级前验证并保留恢复包。
!macro customInstall
  FileOpen $R8 "$INSTDIR\resources\installer-cache-path.txt" w
  FileWriteUTF16LE $R8 "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  FileClose $R8
  !insertmacro ZeusWriteStatus "installed"
!macroend
!endif
