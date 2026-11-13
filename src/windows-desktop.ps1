param([switch]$Worker)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
// Windows Core Audio COM contract: set and independently read back the default playback volume.
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class RoveAudioEnumerator {}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IRoveAudioEnumerator {
 int EnumAudioEndpoints(int flow,int mask,out IntPtr devices);
 [PreserveSig] int GetDefaultAudioEndpoint(int flow,int role,out IRoveAudioDevice device);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IRoveAudioDevice {
 [PreserveSig] int Activate(ref Guid iid,int context,IntPtr parameters,[MarshalAs(UnmanagedType.IUnknown)] out object value);
}
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IRoveEndpointVolume {
 int RegisterControlChangeNotify(IntPtr p); int UnregisterControlChangeNotify(IntPtr p); int GetChannelCount(out uint count);
 int SetMasterVolumeLevel(float level,ref Guid context);
 [PreserveSig] int SetMasterVolumeLevelScalar(float level,ref Guid context);
 int GetMasterVolumeLevel(out float level);
 [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
}
public class RoveAudio {
 public static double[] Increase(int amount) {
  if(amount<1 || amount>20) throw new ArgumentOutOfRangeException("amount");
  object enumerator=new RoveAudioEnumerator(); IRoveAudioDevice device=null; object endpoint=null;
  try {
   Marshal.ThrowExceptionForHR(((IRoveAudioEnumerator)enumerator).GetDefaultAudioEndpoint(0,1,out device));
   Guid iid=new Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), context=Guid.Empty;
   Marshal.ThrowExceptionForHR(device.Activate(ref iid,23,IntPtr.Zero,out endpoint));
   var volume=(IRoveEndpointVolume)endpoint; float before,after;
   Marshal.ThrowExceptionForHR(volume.GetMasterVolumeLevelScalar(out before));
   float target=Math.Min(1f,before+amount/100f);
   Marshal.ThrowExceptionForHR(volume.SetMasterVolumeLevelScalar(target,ref context));
   Marshal.ThrowExceptionForHR(volume.GetMasterVolumeLevelScalar(out after));
   if(Math.Abs(after-target)>0.005) throw new InvalidOperationException("Volume read-back did not match the requested setting. Inspect before retrying.");
   return new double[]{Math.Round(before*100,2),Math.Round(after*100,2)};
  } finally {
   if(endpoint!=null) Marshal.ReleaseComObject(endpoint);
   if(device!=null) Marshal.ReleaseComObject(device);
   Marshal.ReleaseComObject(enumerator);
  }
 }
}
public class RoveWindow {
 public string windowId; public int processId; public string title;
}
public class RoveNative {
 public delegate bool EnumCallback(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback cb,IntPtr p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out int p);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);
 public static int OwnerProcessId(IntPtr h) {int p; GetWindowThreadProcessId(h,out p); return p;}
 public static RoveWindow[] Windows() {
  var windows=new List<RoveWindow>();
  EnumWindows((h,p)=>{var s=new StringBuilder(1024); GetWindowText(h,s,1024);
   if(IsWindowVisible(h)&&s.Length>0) windows.Add(new RoveWindow {windowId=h.ToInt64().ToString(),processId=OwnerProcessId(h),title=s.ToString()}); return true;},IntPtr.Zero);
  return windows.ToArray();
 }
}
'@

} catch { @{error='Windows desktop helper could not initialize.'}|ConvertTo-Json -Compress;exit 1 }
function Invoke-RoveRequest($request) {
try {
  $data=@{}
  $message=''
  function ProcessIdentity($process) {
    $product='';$description=''
    try { $version=$process.MainModule.FileVersionInfo;$product=[string]$version.ProductName;$description=[string]$version.FileDescription } catch {}
    return @{processName=[string]$process.ProcessName;productName=$product;description=$description}
  }
  if ($request.action -eq 'increaseVolume') {
    $levels=[RoveAudio]::Increase([int]$request.amount)
    $data=@{beforePercent=$levels[0];afterPercent=$levels[1];settingVerified=$true;audioAudibilityVerified=$false}
    $message='Verified the default playback volume setting. Muting and actual sound audibility were not changed or verified.'
  } elseif ($request.action -eq 'listWindows') {
    $identities=@{}
    $windows=@(foreach($window in [RoveNative]::Windows()) {
      if(!$identities.ContainsKey($window.processId)) {
        $process=Get-Process -Id $window.processId -ErrorAction SilentlyContinue
        $identities[$window.processId]=if($process){ProcessIdentity $process}else{@{processName='';productName='';description=''}}
      }
      $identity=$identities[$window.processId]
      if(!$request.query -or (($window.title+' '+$identity.processName+' '+$identity.productName+' '+$identity.description).IndexOf([string]$request.query,[StringComparison]::OrdinalIgnoreCase) -ge 0)) {
        @{windowId=$window.windowId;processId=$window.processId;title=$window.title;processName=$identity.processName;productName=$identity.productName;description=$identity.description}
      }
    })
    $data=@{windows=@($windows | Select-Object -First 80);total=$windows.Count;truncated=($windows.Count -gt 80)}
    $message=if($windows.Count){'Observed matching windows with executable product identity. Use the exact window ID and process ID. The product name can differ from the window title and executable name.'}else{'No visible window matched that app identity. Inspect matching processes once or ask which visible window the user means; do not repeat unchanged discovery.'}
  } elseif ($request.action -eq 'listProcesses') {
    $items=@(foreach($process in Get-Process) {
      $identity=ProcessIdentity $process
      if(!$request.name -or (($identity.processName+' '+$identity.productName+' '+$identity.description).IndexOf([string]$request.name,[StringComparison]::OrdinalIgnoreCase) -ge 0)) {
        @{processId=$process.Id;name=$process.ProcessName;title=$process.MainWindowTitle;productName=$identity.productName;description=$identity.description;hasMainWindow=($process.MainWindowHandle -ne [IntPtr]::Zero)}
      }
    })
    $data=@{processes=@($items | Sort-Object @{e='hasMainWindow';Descending=$true} | Select-Object -First 100);total=$items.Count;truncated=($items.Count -gt 100)}
    $message='Observed matching processes.'
  } elseif ($request.action -eq 'stopProcess') {
    Stop-Process -Id $request.processId -Force -ErrorAction Stop
    Start-Sleep -Milliseconds 150
    if (Get-Process -Id $request.processId -ErrorAction SilentlyContinue) { throw 'The process is still running. Windows may have denied access.' }
    $message='Verified the requested process exited.'
    $data=@{processId=$request.processId;exited=$true}
  } elseif ($request.action -eq 'runPowerShell') {
    $global:LASTEXITCODE=0
    $stdout=[Text.StringBuilder]::new();$stderr=[Text.StringBuilder]::new()
    $commandError=$null
    try {
      & ([ScriptBlock]::Create([string]$request.script)) *>&1 | ForEach-Object {
        if($_ -is [Management.Automation.ErrorRecord]) { [void]$stderr.AppendLine([string]$_) }
        else { [void]$stdout.AppendLine(($_ | Out-String).TrimEnd()) }
      }
    } catch { $commandError=$_;[void]$stderr.AppendLine([string]$_) }
    $exitCode=if($commandError){1}else{$LASTEXITCODE}
    $data=@{output=$stdout.ToString();stderr=$stderr.ToString();exitCode=$exitCode}
    $message=if($exitCode -ne 0){'The command exited with code '+$exitCode+'. Inspect the target before retrying.'}else{'PowerShell finished. Check the observed output to verify the requested outcome.'}
  } else {
    $handle=[IntPtr][long]$request.windowId
    $exists=[RoveNative]::IsWindow($handle)
    $owner=[RoveNative]::OwnerProcessId($handle)
    if (!$exists -or $owner -ne $request.processId) { throw 'The window no longer matches that process. List windows again before acting.' }
    switch ($request.action) {
      'closeWindow' {
        if (![RoveNative]::PostMessage($handle,16,[IntPtr]::Zero,[IntPtr]::Zero)) { throw 'Windows denied the close request. The target may be elevated.' }
        $deadline=[DateTime]::UtcNow.AddSeconds(1)
        do {
          $closed=![RoveNative]::IsWindow($handle) -or ![RoveNative]::IsWindowVisible($handle)
          if(!$closed){Start-Sleep -Milliseconds 20}
        } while(!$closed -and [DateTime]::UtcNow -lt $deadline)
        $data=@{windowClosed=$closed;processStillRunning=[bool](Get-Process -Id $request.processId -ErrorAction SilentlyContinue)}
        $message=if($closed){'Verified the window closed or was hidden. Process state is reported separately.'}else{'Close was requested, but the window remains. Inspect for an unsaved-work or confirmation dialog. Do not force-stop without user intent.'}
      }
      'focusWindow' {
        [void][RoveNative]::ShowWindow($handle,9)
        [void][RoveNative]::SetForegroundWindow($handle)
        $focused=[RoveNative]::GetForegroundWindow() -eq $handle
        if (!$focused) { throw 'Windows did not grant foreground focus. The window was restored; inspect before sending input.' }
        $data=@{focused=$true};$message='Verified the requested window is foreground.'
      }
      default {
        $root=[Windows.Automation.AutomationElement]::FromHandle($handle)
        $walker=[Windows.Automation.TreeWalker]::ControlViewWalker
        $queue=[Collections.Generic.Queue[object]]::new();$queue.Enqueue($root)
        $items=[Collections.Generic.List[object]]::new();$found=$null
        while($queue.Count -gt 0 -and $items.Count -lt 160) {
          $element=$queue.Dequeue()
          try {
            $id=$element.GetRuntimeId() -join '.'
            if($request.controlId -and $id -eq $request.controlId){$found=$element;break}
            $current=$element.Current
            $items.Add(@{controlId=$id;name=if($current.IsPassword){'[password field]'}else{$current.Name};type=$current.ControlType.ProgrammaticName;enabled=$current.IsEnabled;offscreen=$current.IsOffscreen;patterns=@($element.GetSupportedPatterns() | ForEach-Object {$_.ProgrammaticName})})
            $child=$walker.GetFirstChild($element)
            while($child -and $queue.Count -lt 200){$queue.Enqueue($child);$child=$walker.GetNextSibling($child)}
          }catch{}
        }
        if($request.action -eq 'inspectWindow') {
          $data=@{controls=@($items.ToArray());truncated=($queue.Count -gt 0)};$message='Observed desktop accessibility controls. Control IDs are valid only for the current UI state.'
        } else {
          if(!$found){throw 'The observed control is no longer present. Inspect the window again.'}
          if($found.Current.IsPassword){throw 'This is a password field. Enter credentials directly in the application.'}
          if($request.action -eq 'invokeControl') {
            $pattern=$null
            if($found.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){ $pattern.Invoke() }
            elseif($found.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)){ $pattern.Select() }
            elseif($found.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern,[ref]$pattern)){ $pattern.Toggle() }
            else {throw 'This control does not expose an invokable accessibility pattern. Use another observed control or PowerShell for the requested task.'}
            $data=@{invoked=$true};$message='The observed control accepted the accessibility action. Inspect the next state to verify the outcome.'
          } elseif($request.action -eq 'fillControl') {
            $pattern=$found.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
            $pattern.SetValue([string]$request.value)
            # Providers can acknowledge SetValue before the target UI thread updates the field.
            # Observe the result without dispatching a duplicate edit.
            $deadline=[DateTime]::UtcNow.AddSeconds(2)
            while($pattern.Current.Value -ne [string]$request.value -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 50}
            if($pattern.Current.Value -ne [string]$request.value){throw 'The field value did not match after filling.'}
            $data=@{valueMatched=$true};$message='Verified the requested field value.'
          } else {throw 'Unknown desktop action.'}
        }
      }
    }
  }

return @{verification='desktop-observed';message=$message;data=$data}
} catch { return @{error=('The desktop action failed. '+$_.Exception.Message)} }
}
if($Worker) {
 while($null -ne ($line=[Console]::ReadLine())) {
  try {$envelope=$line|ConvertFrom-Json;$result=Invoke-RoveRequest $envelope.operation;[Console]::WriteLine((@{id=$envelope.id;result=$result}|ConvertTo-Json -Depth 16 -Compress));[Console]::Out.Flush()}
  catch {[Console]::WriteLine((@{id=$envelope.id;result=@{error='The desktop worker request failed.'}}|ConvertTo-Json -Compress));[Console]::Out.Flush()}
 }
} else {
 $request=[Console]::In.ReadToEnd()|ConvertFrom-Json
 $result=Invoke-RoveRequest $request
 $result|ConvertTo-Json -Depth 16 -Compress
 if($result.error){exit 1}
}
