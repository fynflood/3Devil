; Hooks into the NSIS installer Tauri builds (bundle > windows > nsis > installerHooks).

; The arm64 and x64 installers put 3Devil in the same place, and Tauri's
; installer runs on any PC. Installing the arm64 build on an Intel or AMD PC
; replaced a working copy with one Windows can't start ("This app can't run on
; your PC"), so it stops before copying anything.
!macro NSIS_HOOK_PREINSTALL
  !if "${ARCH}" == "arm64"
    ${IfNot} ${IsNativeARM64}
      MessageBox MB_ICONSTOP|MB_OK "This installer is for Windows on ARM PCs, such as those with a Snapdragon X chip.$\n$\nFor this PC, download 3Devil_${VERSION}_x64-setup.exe from the Releases page instead." /SD IDOK
      Abort
    ${EndIf}
  !endif
!macroend
