# Film Archive — create a Windows shortcut ("Film Archive.lnk") that launches
# the app through the safe updater and shows the app icon.
#
# Run automatically by setup.cmd. Nothing here is hardcoded: every path is
# derived from this script's own location, so it works from any folder on any
# machine. The generated .lnk contains machine-specific absolute paths, so it
# is git-ignored and never published.
$ErrorActionPreference = 'Stop'

$root    = $PSScriptRoot
$pythonw = Join-Path $root '.venv\Scripts\pythonw.exe'
$icon    = Join-Path $root 'img\Icon.ico'
$link    = Join-Path $root 'Film Archive.lnk'

if (-not (Test-Path $pythonw)) {
    Write-Host "  (shortcut skipped: .venv not found - run setup.cmd first)"
    exit 0
}

try {
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($link)
    # Target an .exe (pythonw) so Windows will let you pin it to the taskbar;
    # it runs the updater quietly, which then opens the app window.
    $sc.TargetPath       = $pythonw
    $sc.Arguments        = 'update_and_launch.py'
    $sc.WorkingDirectory = $root
    if (Test-Path $icon) { $sc.IconLocation = "$icon,0" }
    $sc.Description      = 'Film Archive'
    $sc.Save()
    Write-Host "  created 'Film Archive.lnk' - drag it onto your taskbar to pin it."
} catch {
    Write-Host "  (could not create the shortcut: $($_.Exception.Message))"
    exit 0
}

# Stamp the shortcut with an AppUserModelID matching the one the app sets at
# runtime (WINDOWS_APP_ID in app/main.py). This makes the pinned icon and the
# running window share ONE taskbar button instead of two. Best-effort: if the
# COM interop is unavailable the shortcut still works, just with two buttons.
try {
    $csharp = @'
using System;
using System.Runtime.InteropServices;
namespace FilmArchiveShortcut {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] public class ShellLink {}
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
  public interface IShellLinkW {
    void GetPath(System.Text.StringBuilder f,int c,IntPtr d,uint fl); void GetIDList(out IntPtr p); void SetIDList(IntPtr p);
    void GetDescription(System.Text.StringBuilder n,int c); void SetDescription(string n);
    void GetWorkingDirectory(System.Text.StringBuilder d,int c); void SetWorkingDirectory(string d);
    void GetArguments(System.Text.StringBuilder a,int c); void SetArguments(string a);
    void GetHotkey(out short h); void SetHotkey(short h); void GetShowCmd(out int s); void SetShowCmd(int s);
    void GetIconLocation(System.Text.StringBuilder i,int c,out int idx); void SetIconLocation(string i,int idx);
    void SetRelativePath(string r,uint x); void Resolve(IntPtr h,uint f); void SetPath(string p);
  }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")]
  public interface IPersistFile {
    void GetClassID(out Guid c); [PreserveSig] int IsDirty();
    void Load(string f,int m); void Save(string f,[MarshalAs(UnmanagedType.Bool)] bool r); void SaveCompleted(string f); void GetCurFile(out string f);
  }
  [StructLayout(LayoutKind.Sequential)] public struct PROPERTYKEY { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit)] public struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99")]
  public interface IPropertyStore {
    void GetCount(out uint c); void GetAt(uint i,out PROPERTYKEY k);
    void GetValue(ref PROPERTYKEY k,out PROPVARIANT v); void SetValue(ref PROPERTYKEY k,ref PROPVARIANT v); void Commit();
  }
  public static class Aumid {
    public static void Set(string lnk,string id) {
      IShellLinkW link=(IShellLinkW)new ShellLink();
      ((IPersistFile)link).Load(lnk,2);
      IPropertyStore store=(IPropertyStore)link;
      PROPERTYKEY k=new PROPERTYKEY{ fmtid=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid=5 };
      PROPVARIANT v=new PROPVARIANT{ vt=31, p=Marshal.StringToCoTaskMemUni(id) };
      store.SetValue(ref k,ref v); store.Commit(); Marshal.FreeCoTaskMem(v.p);
      ((IPersistFile)link).Save(lnk,true);
    }
  }
}
'@
    if (-not ("FilmArchiveShortcut.Aumid" -as [type])) {
        Add-Type -TypeDefinition $csharp -ErrorAction Stop
    }
    [FilmArchiveShortcut.Aumid]::Set($link, 'FilmArchive.App')
    Write-Host "  taskbar identity set (pinned + running share one button)."
} catch {
    Write-Host "  (taskbar identity not set - the shortcut still works)"
}
exit 0
