$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$form = [Windows.Forms.Form]::new()
$form.Text = 'Sidekick - OpenAI API key'
$form.ClientSize = [Drawing.Size]::new(470, 133)
$form.FormBorderStyle = 'FixedDialog'
$form.StartPosition = 'CenterScreen'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$label = [Windows.Forms.Label]::new()
$label.Text = 'Paste your OpenAI API key with Ctrl+V, then select Save.'
$label.SetBounds(13, 12, 440, 23)
$inputBox = [Windows.Forms.TextBox]::new()
$inputBox.UseSystemPasswordChar = $true
$inputBox.MaxLength = 512
$inputBox.SetBounds(14, 43, 442, 24)
$save = [Windows.Forms.Button]::new()
$save.Text = 'Save'
$save.DialogResult = 'OK'
$save.SetBounds(288, 91, 80, 28)
$cancel = [Windows.Forms.Button]::new()
$cancel.Text = 'Cancel'
$cancel.DialogResult = 'Cancel'
$cancel.SetBounds(376, 91, 80, 28)
$form.Controls.AddRange(@($label, $inputBox, $save, $cancel))
$form.AcceptButton = $save
$form.CancelButton = $cancel
$form.ActiveControl = $inputBox
try {
    if ($form.ShowDialog() -eq 'OK') { [Console]::Out.Write($inputBox.Text) }
} finally {
    $inputBox.Clear()
    $form.Dispose()
}


