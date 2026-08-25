param(
    [string]$ConfigPath,
    [string]$CurrentMode = "off",
    [string]$CurrentProfile = "Profile pending",
    [string]$SourceResolution = "Unknown"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$settingsVersion = 2
$presetKeys = @("standard", "adaptive", "ultra", "ultra-custom")
$presetLabels = @{
    "standard" = "Standard"
    "adaptive" = "Adaptive"
    "ultra" = "Ultra"
    "ultra-custom" = "UltraCustom"
}
$defaults = @{
    strength_bias = 1.0
    detail_radius = 1.0
    edge_sensitivity = 1.0
    noise_protection = 1.0
    halo_control = 1.0
}

function Copy-Settings {
    param([System.Collections.IDictionary]$Settings)
    return @{
        strength_bias = [double]$Settings["strength_bias"]
        detail_radius = [double]$Settings["detail_radius"]
        edge_sensitivity = [double]$Settings["edge_sensitivity"]
        noise_protection = [double]$Settings["noise_protection"]
        halo_control = [double]$Settings["halo_control"]
    }
}

function Get-ObjectValue {
    param(
        [object]$Object,
        [string]$Name,
        [object]$Fallback
    )
    if ($null -eq $Object) {
        return $Fallback
    }
    if ($Object -is [System.Collections.IDictionary] -and $Object.Contains($Name)) {
        return $Object[$Name]
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property -and $null -ne $property.Value) {
        return $property.Value
    }
    return $Fallback
}

function ConvertTo-PresetSettings {
    param([object]$RawSettings)
    $result = @{}
    foreach ($key in $defaults.Keys) {
        $value = [double](Get-ObjectValue -Object $RawSettings -Name $key -Fallback $defaults[$key])
        $result[$key] = [Math]::Max(0.125, [Math]::Min(3.0, $value))
    }
    return $result
}

function New-DefaultConfig {
    $presets = @{}
    foreach ($key in $presetKeys) {
        $presets[$key] = Copy-Settings -Settings $defaults
    }
    return @{
        version = $settingsVersion
        presets = $presets
    }
}

function Get-Config {
    param([string]$Path)

    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) {
        return New-DefaultConfig
    }

    try {
        $raw = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        $config = New-DefaultConfig
        $rawPresets = Get-ObjectValue -Object $raw -Name "presets" -Fallback $null
        if ($null -ne $rawPresets) {
            foreach ($key in $presetKeys) {
                $rawPreset = Get-ObjectValue -Object $rawPresets -Name $key -Fallback $null
                $config.presets[$key] = ConvertTo-PresetSettings -RawSettings $rawPreset
            }
            return $config
        }

        # Match the Lua migration: preserve legacy tuning for all non-canonical
        # presets, while canonical Ultra starts from neutral 1.000 values.
        $legacy = ConvertTo-PresetSettings -RawSettings $raw
        $config.presets["standard"] = Copy-Settings -Settings $legacy
        $config.presets["adaptive"] = Copy-Settings -Settings $legacy
        $config.presets["ultra-custom"] = Copy-Settings -Settings $legacy
        return $config
    } catch {
        return New-DefaultConfig
    }
}

function Save-Config {
    param(
        [string]$Path,
        [hashtable]$Config
    )

    if (-not $Path) {
        return
    }

    $folder = Split-Path -Parent $Path
    if ($folder -and -not (Test-Path -LiteralPath $folder)) {
        New-Item -ItemType Directory -Path $folder -Force | Out-Null
    }

    $Config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Path -Encoding UTF8
}

$config = Get-Config -Path $ConfigPath
$normalizedCurrentMode = $CurrentMode.ToLowerInvariant()
$script:selectedPresetKey = if ($presetKeys -contains $normalizedCurrentMode) { $normalizedCurrentMode } else { "standard" }

$form = New-Object System.Windows.Forms.Form
$form.Text = "Streamee Sharpener Options"
$form.StartPosition = "CenterScreen"
$form.Size = New-Object System.Drawing.Size(760, 535)
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(22, 22, 24)
$form.ForeColor = [System.Drawing.Color]::White

$title = New-Object System.Windows.Forms.Label
$title.Text = "Current mode: $CurrentMode"
$title.Location = New-Object System.Drawing.Point(20, 15)
$title.Size = New-Object System.Drawing.Size(700, 22)
$title.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($title)

$profileLabel = New-Object System.Windows.Forms.Label
$profileLabel.Text = "Current profile: $CurrentProfile"
$profileLabel.Location = New-Object System.Drawing.Point(20, 38)
$profileLabel.Size = New-Object System.Drawing.Size(700, 20)
$profileLabel.ForeColor = [System.Drawing.Color]::Gainsboro
$form.Controls.Add($profileLabel)

$sourceLabel = New-Object System.Windows.Forms.Label
$sourceLabel.Text = "Source resolution: $SourceResolution"
$sourceLabel.Location = New-Object System.Drawing.Point(20, 58)
$sourceLabel.Size = New-Object System.Drawing.Size(700, 20)
$sourceLabel.ForeColor = [System.Drawing.Color]::Gainsboro
$form.Controls.Add($sourceLabel)

$presetLabel = New-Object System.Windows.Forms.Label
$presetLabel.Text = "Edit preset:"
$presetLabel.Location = New-Object System.Drawing.Point(20, 86)
$presetLabel.Size = New-Object System.Drawing.Size(100, 22)
$form.Controls.Add($presetLabel)

$presetSelector = New-Object System.Windows.Forms.ComboBox
$presetSelector.Location = New-Object System.Drawing.Point(120, 82)
$presetSelector.Size = New-Object System.Drawing.Size(170, 24)
$presetSelector.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
foreach ($key in $presetKeys) {
    $null = $presetSelector.Items.Add($presetLabels[$key])
}
$presetSelector.SelectedIndex = [Array]::IndexOf($presetKeys, $script:selectedPresetKey)
$form.Controls.Add($presetSelector)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = "Range: 0.125-3.000; 1.000 is neutral. Active-preset changes apply live."
$hint.Location = New-Object System.Drawing.Point(20, 116)
$hint.Size = New-Object System.Drawing.Size(700, 20)
$hint.ForeColor = [System.Drawing.Color]::Gainsboro
$form.Controls.Add($hint)

$selectedSettings = $config.presets[$script:selectedPresetKey]
$sliderDefs = @(
    @{ Key = "strength_bias"; Label = "Strength Bias"; Top = 155; Value = $selectedSettings.strength_bias },
    @{ Key = "detail_radius"; Label = "Detail Radius"; Top = 210; Value = $selectedSettings.detail_radius },
    @{ Key = "edge_sensitivity"; Label = "Edge Sensitivity"; Top = 265; Value = $selectedSettings.edge_sensitivity },
    @{ Key = "noise_protection"; Label = "Noise Protection"; Top = 320; Value = $selectedSettings.noise_protection },
    @{ Key = "halo_control"; Label = "Halo Control"; Top = 375; Value = $selectedSettings.halo_control }
)

$trackbars = @{}
$valueLabels = @{}
$nameLabels = @{}
$script:isInitializing = $true

foreach ($def in $sliderDefs) {
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $def.Label
    $label.Location = New-Object System.Drawing.Point(20, $def.Top)
    $label.Size = New-Object System.Drawing.Size(160, 20)
    $nameLabels[$def.Key] = $label
    $form.Controls.Add($label)

    $track = New-Object System.Windows.Forms.TrackBar
    $track.Location = New-Object System.Drawing.Point(180, ($def.Top - 6))
    $track.Size = New-Object System.Drawing.Size(440, 45)
    $track.Minimum = 125
    $track.Maximum = 3000
    $track.TickFrequency = 125
    $track.SmallChange = 5
    $track.LargeChange = 25
    $track.Value = [Math]::Max($track.Minimum, [Math]::Min($track.Maximum, [Math]::Round([double]$def.Value * 1000)))
    $track.BackColor = $form.BackColor
    $trackbars[$def.Key] = $track
    $form.Controls.Add($track)

    $valueLabel = New-Object System.Windows.Forms.Label
    $valueLabel.Location = New-Object System.Drawing.Point(650, $def.Top)
    $valueLabel.Size = New-Object System.Drawing.Size(70, 20)
    $valueLabel.TextAlign = "MiddleRight"
    $valueLabel.Text = "{0:N3}" -f ($track.Value / 1000.0)
    $valueLabels[$def.Key] = $valueLabel
    $form.Controls.Add($valueLabel)

    $track.Add_ValueChanged({
        $currentTrack = $this
        foreach ($pair in $trackbars.GetEnumerator()) {
            if ($pair.Value -eq $currentTrack) {
                $valueLabels[$pair.Key].Text = "{0:N3}" -f ($currentTrack.Value / 1000.0)
                if (-not $script:isInitializing) {
                    $liveSaveTimer.Stop()
                    $liveSaveTimer.Start()
                }
                break
            }
        }
    })
}

function Get-CurrentPresetSettings {
    return @{
        strength_bias = [Math]::Round($trackbars["strength_bias"].Value / 1000.0, 3)
        detail_radius = [Math]::Round($trackbars["detail_radius"].Value / 1000.0, 3)
        edge_sensitivity = [Math]::Round($trackbars["edge_sensitivity"].Value / 1000.0, 3)
        noise_protection = [Math]::Round($trackbars["noise_protection"].Value / 1000.0, 3)
        halo_control = [Math]::Round($trackbars["halo_control"].Value / 1000.0, 3)
    }
}

function Save-SelectedPreset {
    $config.presets[$script:selectedPresetKey] = Get-CurrentPresetSettings
    Save-Config -Path $ConfigPath -Config $config
}

function Load-PresetControls {
    param([string]$PresetKey)

    $script:isInitializing = $true
    $settings = $config.presets[$PresetKey]
    foreach ($key in $trackbars.Keys) {
        $value = [Math]::Round([double]$settings[$key] * 1000)
        $trackbars[$key].Value = [Math]::Max($trackbars[$key].Minimum, [Math]::Min($trackbars[$key].Maximum, $value))
        $valueLabels[$key].Text = "{0:N3}" -f ($trackbars[$key].Value / 1000.0)
    }

    $isCanonicalUltra = $PresetKey -eq "ultra"
    $trackbars["detail_radius"].Enabled = -not $isCanonicalUltra
    $nameLabels["detail_radius"].Enabled = -not $isCanonicalUltra
    $valueLabels["detail_radius"].Enabled = -not $isCanonicalUltra
    if ($isCanonicalUltra) {
        $valueLabels["detail_radius"].Text = "Not used"
        $hint.Text = "Range: 0.125-3.000; Ultra keeps its canonical kernel and does not use Detail Radius."
    } else {
        $hint.Text = "Range: 0.125-3.000; 1.000 is neutral. Active-preset changes apply live."
    }
    $script:isInitializing = $false
}

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = "Ready - move any slider to apply"
$statusLabel.Location = New-Object System.Drawing.Point(20, 444)
$statusLabel.Size = New-Object System.Drawing.Size(500, 20)
$statusLabel.ForeColor = [System.Drawing.Color]::Gainsboro
$form.Controls.Add($statusLabel)

$resetButton = New-Object System.Windows.Forms.Button
$resetButton.Text = "Reset"
$resetButton.Location = New-Object System.Drawing.Point(550, 436)
$resetButton.Size = New-Object System.Drawing.Size(80, 30)
$form.Controls.Add($resetButton)

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Text = "Close"
$closeButton.Location = New-Object System.Drawing.Point(640, 436)
$closeButton.Size = New-Object System.Drawing.Size(80, 30)
$closeButton.BackColor = [System.Drawing.Color]::FromArgb(255, 107, 53)
$closeButton.ForeColor = [System.Drawing.Color]::White
$form.Controls.Add($closeButton)

$liveSaveTimer = New-Object System.Windows.Forms.Timer
$liveSaveTimer.Interval = 75
$liveSaveTimer.Add_Tick({
    $liveSaveTimer.Stop()
    Save-SelectedPreset
    $presetName = $presetLabels[$script:selectedPresetKey]
    if ($script:selectedPresetKey -eq $normalizedCurrentMode) {
        $statusLabel.Text = "$presetName applied live at $([DateTime]::Now.ToString('HH:mm:ss.fff'))"
    } else {
        $statusLabel.Text = "$presetName saved; select that mode in MPV to preview it"
    }
})

$presetSelector.Add_SelectedIndexChanged({
    if ($script:isInitializing -or $presetSelector.SelectedIndex -lt 0) {
        return
    }
    $liveSaveTimer.Stop()
    Save-SelectedPreset
    $script:selectedPresetKey = $presetKeys[$presetSelector.SelectedIndex]
    Load-PresetControls -PresetKey $script:selectedPresetKey
    $statusLabel.Text = "Editing $($presetLabels[$script:selectedPresetKey]) preset"
})

Load-PresetControls -PresetKey $script:selectedPresetKey
Save-Config -Path $ConfigPath -Config $config

$resetButton.Add_Click({
    foreach ($pair in $trackbars.GetEnumerator()) {
        $pair.Value.Value = [Math]::Round([double]$defaults[$pair.Key] * 1000)
    }
})

$closeButton.Add_Click({
    $form.Close()
})

$form.Add_FormClosing({
    $liveSaveTimer.Stop()
    Save-SelectedPreset
})

$null = $form.ShowDialog()
