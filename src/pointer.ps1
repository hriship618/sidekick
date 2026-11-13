$ErrorActionPreference='Stop'
try {
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public class RoveMouseState {
 [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
}
'@
$previous=-1
while($true) {
 $key=if([RoveMouseState]::GetSystemMetrics(23)){2}else{1}
 $down=if(([RoveMouseState]::GetAsyncKeyState($key) -band 32768) -ne 0){1}else{0}
 if($down -ne $previous){[Console]::WriteLine($down);[Console]::Out.Flush();$previous=$down}
 Start-Sleep -Milliseconds 8
}
} catch { exit 1 }
