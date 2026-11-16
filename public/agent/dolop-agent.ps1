<#
.SYNOPSIS
    dolop device agent: moves an Entra ID-joined Windows device to another
    tenant without wiping it, keeping the user's Windows profile.

.DESCRIPTION
    Create the command for a device on the Devices tab in dolop, then run it in
    an elevated (Run as administrator) Windows PowerShell on that device.

    Modes:
      Check           Pre-flight checks only. Changes nothing. Results appear in dolop.
      Schedule        Runs Check, then installs a SYSTEM scheduled task that runs
                      Migrate at -At (default: in two minutes).
      Unschedule      Removes a scheduled migration that has not started yet.
      Migrate         Run by the scheduled task. Hands the user's profile to their
                      destination account, leaves the source tenant, joins the
                      destination tenant with the provisioning package, restarts.
                      Without a package (or with -ManualJoin) it stops after leaving
                      the source tenant: join the device to the destination tenant
                      by hand in Settings after the restart.
      PostJoin        Runs after Migrate (at start-up, and every 10 minutes while
                      waiting for a manual join). Confirms the join, backs BitLocker
                      keys up to the new tenant, restores local group memberships
                      and reports completion.
      RestoreProfile  Undoes the profile hand-over from the latest backup.

    Everything is logged to %ProgramData%\Dolop\agent.log and reported to dolop.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Server,
    [string]$Token,
    [ValidateSet('Check', 'Schedule', 'Unschedule', 'Migrate', 'PostJoin', 'RestoreProfile')]
    [string]$Mode = 'Check',
    [string]$At,
    [switch]$ForceLogoff,
    [switch]$SkipLocalAdminCheck,
    [switch]$ManualJoin
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$AgentVersion = '1.0.0'
$Protocol = 1
$Root = Join-Path $env:ProgramData 'Dolop'
$LogFile = Join-Path $Root 'agent.log'
$TaskPath = '\Dolop\'
$TaskMigrate = 'Dolop Device Migration'
$TaskPostJoin = 'Dolop Device Migration - Finish'
$ProfileListPath = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
$HiveMount = 'DolopProfileHive'
$ManualJoinDays = 3
$Server = $Server.TrimEnd('/')
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

# ---------------------------------------------------------------------------
# Native programs

# Run a native program and capture its output and exit code. Windows PowerShell
# 5.1 turns redirected stderr into terminating errors under ErrorAction Stop,
# and reg.exe even reports success on stderr, so every native call goes here.
function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = (& $Exe @Arguments 2>&1 | ForEach-Object { "$_" }) -join "`n"
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $prev }
    return [pscustomobject]@{ ExitCode = $code; Output = $out }
}

# ---------------------------------------------------------------------------
# Logging and the dolop API

function Initialize-Root {
    if (-not (Test-Path $Root)) { New-Item -ItemType Directory -Path $Root -Force | Out-Null }
    # SYSTEM and Administrators only: the token and the provisioning package live here.
    Invoke-Native 'icacls.exe' @($Root, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/Q') | Out-Null
}

function Write-Log([string]$Message, [string]$Level = 'INFO') {
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 's'), $Level, $Message
    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch { }
    if ($Level -eq 'ERROR') { Write-Host $line -ForegroundColor Red }
    elseif ($Level -eq 'WARN') { Write-Host $line -ForegroundColor Yellow }
    else { Write-Host $line }
}

function Get-AgentToken {
    if ($Token) { return $Token }
    $file = Join-Path $Root 'token'
    if (Test-Path $file) { return (Get-Content -Path $file -Raw).Trim() }
    throw 'No agent token: pass -Token, or run Schedule first.'
}

function Invoke-Dolop([string]$Method, [string]$Path, $Body = $null, [string]$OutFile = $null) {
    $headers = @{ Authorization = 'Bearer ' + (Get-AgentToken) }
    $uri = $Server + $Path
    $last = $null
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        try {
            if ($OutFile) {
                Invoke-WebRequest -Uri $uri -Headers $headers -OutFile $OutFile -UseBasicParsing | Out-Null
                return $null
            }
            if ($null -ne $Body) {
                $json = ConvertTo-Json -InputObject $Body -Depth 8 -Compress
                $bytes = [Text.Encoding]::UTF8.GetBytes($json)
                return Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers -Body $bytes `
                    -ContentType 'application/json; charset=utf-8' -UseBasicParsing
            }
            return Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers -UseBasicParsing
        } catch {
            $last = $_
            $status = $null
            try { $status = [int]$_.Exception.Response.StatusCode } catch { }
            # 4xx answers won't change on retry (bad or expired token, missing package).
            if ($status -ge 400 -and $status -lt 500) { break }
            Start-Sleep -Seconds ([Math]::Min(30, 3 * $attempt * $attempt))
        }
    }
    $detail = $last.Exception.Message
    try {
        if ($last.ErrorDetails -and $last.ErrorDetails.Message) {
            $detail = (ConvertFrom-Json $last.ErrorDetails.Message).error
        }
    } catch { }
    throw "dolop request $Method $Path failed: $detail"
}

function Send-Report {
    param(
        [string]$Phase, [string]$Step, [string]$Status, [string]$Detail,
        $Checks = $null, [hashtable]$Data = $null, $BitLocker = $null
    )
    $level = if ($Status -eq 'fail') { 'ERROR' } elseif ($Status -eq 'warn') { 'WARN' } else { 'INFO' }
    Write-Log ("[{0}/{1}] {2}: {3}" -f $Phase, $Step, $Status, $Detail) $level
    $body = @{ phase = $Phase; step = $Step; status = $Status; detail = $Detail }
    if ($null -ne $Checks) { $body.checks = @($Checks) }
    $d = @{ agentVersion = $AgentVersion; osBuild = [Environment]::OSVersion.Version.ToString() }
    if ($Data) { foreach ($k in $Data.Keys) { $d[$k] = $Data[$k] } }
    $body.data = $d
    if ($BitLocker) { $body.bitlocker = @($BitLocker) }
    try { Invoke-Dolop 'POST' '/api/agent/report' $body | Out-Null }
    catch { Write-Log "Could not report to dolop: $($_.Exception.Message)" 'WARN' }
}

# ---------------------------------------------------------------------------
# Device facts

function Test-Elevated {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-Dsreg {
    $result = @{}
    $lines = (Invoke-Native 'dsregcmd.exe' @('/status')).Output -split "`n"
    foreach ($line in $lines) {
        if ($line -match '^\s*([A-Za-z][A-Za-z0-9 ]*?)\s*:\s*(.*?)\s*$') {
            if (-not $result.ContainsKey($Matches[1])) { $result[$Matches[1]] = $Matches[2] }
        }
    }
    return $result
}

function Get-DsregValue($Dsreg, [string]$Name) {
    if ($Dsreg.ContainsKey($Name)) { return [string]$Dsreg[$Name] }
    return ''
}

function Test-SameGuid([string]$A, [string]$B) {
    if (-not $A -or -not $B) { return $false }
    return $A.Trim('{} ').ToLowerInvariant() -eq $B.Trim('{} ').ToLowerInvariant()
}

function Get-SidBytes([string]$Sid) {
    $sidObj = New-Object Security.Principal.SecurityIdentifier($Sid)
    $bytes = New-Object byte[] ($sidObj.BinaryLength)
    $sidObj.GetBinaryForm($bytes, 0)
    return , $bytes
}

function Get-ProfileEntry([string]$Sid) {
    $path = Join-Path $ProfileListPath $Sid
    if (-not (Test-Path $path)) { return $null }
    $item = Get-Item -Path $path
    $image = $item.GetValue('ProfileImagePath', $null, 'DoNotExpandEnvironmentNames')
    return [pscustomobject]@{
        Sid = $Sid
        RegPath = $path
        ImagePathRaw = $image
        ImagePath = if ($image) { [Environment]::ExpandEnvironmentVariables($image) } else { $null }
    }
}

function Test-HiveLoaded([string]$Sid) {
    return Test-Path ("Registry::HKEY_USERS\" + $Sid)
}

function Get-MemberSid($Member) {
    try {
        $bytes = $Member.GetType().InvokeMember('objectSid', 'GetProperty', $null, $Member, $null)
        return (New-Object Security.Principal.SecurityIdentifier($bytes, 0)).Value
    } catch { return $null }
}

# Local groups the given SID belongs to (ADSI copes with unresolvable cloud SIDs,
# which make Get-LocalGroupMember fail).
function Get-LocalGroupsOf([string]$Sid) {
    $groups = @()
    $computer = [ADSI]("WinNT://" + $env:COMPUTERNAME + ",computer")
    foreach ($child in $computer.psbase.Children) {
        if ($child.psbase.SchemaClassName -ne 'Group') { continue }
        try {
            foreach ($m in @($child.psbase.Invoke('Members'))) {
                if ((Get-MemberSid $m) -eq $Sid) { $groups += [string]$child.Name[0]; break }
            }
        } catch { }
    }
    return , $groups
}

function Get-EnabledLocalAdmins {
    $names = @()
    $adminsName = (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')).Translate([Security.Principal.NTAccount]).Value.Split('\')[-1]
    $group = [ADSI]("WinNT://" + $env:COMPUTERNAME + "/" + $adminsName + ",group")
    $memberSids = @{}
    foreach ($m in @($group.psbase.Invoke('Members'))) {
        $sid = Get-MemberSid $m
        if ($sid) { $memberSids[$sid] = $true }
    }
    foreach ($u in @(Get-LocalUser)) {
        if ($u.Enabled -and $memberSids.ContainsKey($u.SID.Value)) { $names += $u.Name }
    }
    return , $names
}

function Get-RecoveryPasswords {
    $keys = @()
    $state = 'unknown'
    try {
        $vol = Get-BitLockerVolume -MountPoint $env:SystemDrive -ErrorAction Stop
        $state = [string]$vol.ProtectionStatus
        foreach ($p in @($vol.KeyProtector)) {
            if ([string]$p.KeyProtectorType -eq 'RecoveryPassword' -and $p.RecoveryPassword) {
                $keys += @{ id = $p.KeyProtectorId.Trim('{}'); key = $p.RecoveryPassword; volume = 'OperatingSystemVolume' }
            }
        }
    } catch { $state = 'unavailable' }
    return [pscustomobject]@{ State = $state; Keys = $keys }
}

function Get-MdmEnrollments {
    $list = @()
    $base = 'HKLM:\SOFTWARE\Microsoft\Enrollments'
    if (-not (Test-Path $base)) { return , $list }
    foreach ($k in @(Get-ChildItem -Path $base -ErrorAction SilentlyContinue)) {
        if ($k.PSChildName -notmatch '^[0-9A-Fa-f]{8}-') { continue }
        $provider = $k.GetValue('ProviderID', $null)
        if ($provider -eq 'MS DM Server') { $list += $k.PSChildName }
    }
    return , $list
}

function Get-Plan {
    $plan = Invoke-Dolop 'GET' '/api/agent/plan'
    if ([int]$plan.protocol -ne $Protocol) {
        throw "This agent speaks protocol $Protocol but dolop expects $($plan.protocol): run the latest command from dolop."
    }
    return $plan
}

# 'package': join with the provisioning package. 'manual': someone joins the
# device in Settings after the agent has left the source tenant.
function Get-JoinMode($Plan) {
    if ($ManualJoin) { return 'manual' }
    if ($Plan.PSObject.Properties['joinMode'] -and $Plan.joinMode) { return [string]$Plan.joinMode }
    if ($Plan.package.available) { return 'package' }
    return 'manual'
}

# ---------------------------------------------------------------------------
# Pre-flight

function Invoke-Checks($Plan, [bool]$Strict) {
    $checks = New-Object System.Collections.ArrayList
    $ctx = @{}
    function Add-Check([string]$Name, [string]$Status, [string]$Detail) {
        [void]$checks.Add(@{ name = $Name; status = $Status; detail = $Detail })
    }

    if (Test-Elevated) { Add-Check 'elevated' 'ok' 'Running elevated' }
    else { Add-Check 'elevated' 'fail' 'Run PowerShell as administrator' }

    $os = Get-CimInstance Win32_OperatingSystem
    if ([Environment]::OSVersion.Version.Major -lt 10) { Add-Check 'windows' 'fail' "$($os.Caption) is not supported" }
    elseif ($os.Caption -match 'Home') { Add-Check 'windows' 'fail' "$($os.Caption) cannot join Entra ID: upgrade to Pro" }
    else { Add-Check 'windows' 'ok' "$($os.Caption) $($os.Version)" }

    $dsreg = Get-Dsreg
    $joined = (Get-DsregValue $dsreg 'AzureAdJoined') -eq 'YES'
    $tenant = Get-DsregValue $dsreg 'TenantId'
    $ctx.SourceJoined = $joined -and (Test-SameGuid $tenant $Plan.sourceTenantId)
    $ctx.DestJoined = $joined -and (Test-SameGuid $tenant $Plan.destTenantId)
    if ($ctx.SourceJoined) { Add-Check 'joined_source' 'ok' "Joined to the source tenant ($tenant)" }
    elseif ($ctx.DestJoined) { Add-Check 'joined_source' 'warn' 'Already joined to the destination tenant' }
    elseif ($joined) { Add-Check 'joined_source' 'fail' "Joined to an unexpected tenant ($tenant)" }
    else { $ctx.Unjoined = $true; Add-Check 'joined_source' 'fail' 'Not joined to Entra ID' }

    if ((Get-DsregValue $dsreg 'DomainJoined') -eq 'YES') {
        Add-Check 'not_hybrid' 'fail' 'Joined to on-premises Active Directory (hybrid): not supported'
    } else { Add-Check 'not_hybrid' 'ok' 'Not joined to on-premises AD' }

    $deviceId = Get-DsregValue $dsreg 'DeviceId'
    if ($Plan.device.entraDeviceId -and $ctx.SourceJoined -and -not (Test-SameGuid $deviceId $Plan.device.entraDeviceId)) {
        Add-Check 'right_device' 'fail' "This command is for $($Plan.device.name), not this device ($env:COMPUTERNAME)"
    } else { Add-Check 'right_device' 'ok' $env:COMPUTERNAME }

    $src = Get-ProfileEntry $Plan.sourceUser.sid
    $dst = Get-ProfileEntry $Plan.destUser.sid
    $ctx.SourceProfile = $src
    $ctx.AlreadyMapped = ($null -eq $src) -and ($null -ne $dst)
    if ($ctx.AlreadyMapped) {
        Add-Check 'profile' 'ok' "Profile already handed to $($Plan.destUser.upn) ($($dst.ImagePath))"
        $ctx.ProfilePath = $dst.ImagePath
        if ($ctx.Unjoined) {
            # A previous run handed the profile over and left the source tenant,
            # then could not join: a re-run only needs to join.
            for ($i = 0; $i -lt $checks.Count; $i++) {
                if ($checks[$i].name -eq 'joined_source') { $checks[$i] = @{ name = 'joined_source'; status = 'warn'; detail = 'Not joined to any tenant: a previous run already left the source tenant; this run joins the destination' } }
            }
        }
    } elseif ($null -eq $src) {
        Add-Check 'profile' 'fail' "$($Plan.sourceUser.upn) has no profile on this device (never signed in here?)"
    } elseif (-not $src.ImagePath -or -not (Test-Path -LiteralPath $src.ImagePath)) {
        Add-Check 'profile' 'fail' "Profile folder $($src.ImagePath) is missing"
    } elseif ($null -ne $dst) {
        Add-Check 'profile' 'fail' "$($Plan.destUser.upn) already has its own profile ($($dst.ImagePath)): delete it first"
    } else {
        Add-Check 'profile' 'ok' "$($Plan.sourceUser.upn): $($src.ImagePath)"
        $ctx.ProfilePath = $src.ImagePath
    }

    if ($src -and (Test-HiveLoaded $Plan.sourceUser.sid)) {
        if ($ForceLogoff) { Add-Check 'signed_out' 'warn' 'User is signed in: they will be signed out when the migration starts' }
        elseif ($Strict) { Add-Check 'signed_out' 'fail' 'User is still signed in: sign them out (or schedule with -ForceLogoff)' }
        else { Add-Check 'signed_out' 'warn' 'User is signed in: they must be signed out at migration time (or use -ForceLogoff)' }
    } else { Add-Check 'signed_out' 'ok' 'User is signed out' }

    $joinMode = Get-JoinMode $Plan
    $ctx.JoinMode = $joinMode
    try {
        $admins = Get-EnabledLocalAdmins
        if ($admins.Count -gt 0) { Add-Check 'local_admin' 'ok' ("Enabled local admin account(s): " + ($admins -join ', ')) }
        elseif ($joinMode -eq 'manual') { Add-Check 'local_admin' 'fail' 'No enabled local administrator account: one is needed to sign in and join the destination tenant by hand' }
        elseif ($SkipLocalAdminCheck) { Add-Check 'local_admin' 'warn' 'No enabled local admin account (check skipped)' }
        else { Add-Check 'local_admin' 'fail' 'No enabled local administrator account: create one (or enable LAPS) so the device stays recoverable' }
    } catch { Add-Check 'local_admin' 'warn' "Could not list local admins: $($_.Exception.Message)" }

    if ($joinMode -eq 'manual') {
        Add-Check 'join' 'warn' 'Manual join: after the restart, sign in with the local admin account and join the destination tenant in Settings'
    } else {
        if ($Plan.package.available) { Add-Check 'package' 'ok' 'Provisioning package available' }
        else { Add-Check 'package' 'fail' 'No provisioning package uploaded in dolop (or use -ManualJoin)' }
        try {
            if (Get-Command Install-ProvisioningPackage -ErrorAction SilentlyContinue) { Add-Check 'provisioning' 'ok' 'Install-ProvisioningPackage available' }
            else { Add-Check 'provisioning' 'fail' 'Install-ProvisioningPackage is not available on this Windows build (use -ManualJoin)' }
        } catch { Add-Check 'provisioning' 'fail' $_.Exception.Message }
    }

    $drive = Get-PSDrive -Name $env:SystemDrive.TrimEnd(':')
    $freeGb = [Math]::Round($drive.Free / 1GB, 1)
    if ($freeGb -lt 2) { Add-Check 'disk' 'warn' "Only $freeGb GB free on $env:SystemDrive" } else { Add-Check 'disk' 'ok' "$freeGb GB free" }

    $bl = Get-RecoveryPasswords
    $ctx.BitLocker = $bl
    if ($bl.State -eq 'On' -and $bl.Keys.Count -eq 0) { Add-Check 'bitlocker' 'warn' 'BitLocker is on but has no recovery password protector' }
    elseif ($bl.State -eq 'On') { Add-Check 'bitlocker' 'ok' "BitLocker on; $($bl.Keys.Count) recovery password(s) saved to dolop" }
    else { Add-Check 'bitlocker' 'ok' "BitLocker: $($bl.State)" }

    $ctx.Enrollments = Get-MdmEnrollments
    if ($ctx.Enrollments.Count -gt 0) { Add-Check 'intune' 'ok' "Intune enrollment found ($($ctx.Enrollments.Count))" }
    else { Add-Check 'intune' 'ok' 'Not enrolled in Intune' }

    return [pscustomobject]@{ Checks = $checks; Context = $ctx; Failed = @($checks | Where-Object { $_.status -eq 'fail' }).Count }
}

function Show-Checks($Result) {
    Write-Host ''
    foreach ($c in $Result.Checks) {
        $color = if ($c.status -eq 'fail') { 'Red' } elseif ($c.status -eq 'warn') { 'Yellow' } else { 'Green' }
        Write-Host ('  [{0,-4}] {1,-14} {2}' -f $c.status.ToUpper(), $c.name, $c.detail) -ForegroundColor $color
    }
    Write-Host ''
}

# ---------------------------------------------------------------------------
# Profile hand-over

function Get-LatestBackup {
    $dirs = @(Get-ChildItem -Path $Root -Directory -Filter 'backup-*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
    if ($dirs.Count -eq 0) { return $null }
    return $dirs[0].FullName
}

function Mount-Hive([string]$File) {
    # A crashed earlier run may have left the hive mounted.
    Invoke-Native 'reg.exe' @('unload', "HKU\$HiveMount") | Out-Null
    $r = Invoke-Native 'reg.exe' @('load', "HKU\$HiveMount", $File)
    if ($r.ExitCode -ne 0) { throw "Could not load $File (is the user still signed in?) $($r.Output)" }
}

function Dismount-Hive {
    for ($i = 0; $i -lt 6; $i++) {
        [GC]::Collect()
        [GC]::WaitForPendingFinalizers()
        if ((Invoke-Native 'reg.exe' @('unload', "HKU\$HiveMount")).ExitCode -eq 0) { return }
        Start-Sleep -Seconds 2
    }
    throw 'Could not unload the user registry hive'
}

# Give the new SID full control of a loaded hive: the root (inherited by
# children) plus every key that blocks inheritance.
function Grant-HiveAccess([string]$Sid) {
    $sidObj = New-Object Security.Principal.SecurityIdentifier($Sid)
    $rule = New-Object Security.AccessControl.RegistryAccessRule($sidObj, 'FullControl', 'ContainerInherit', 'None', 'Allow')
    $rights = [Security.AccessControl.RegistryRights]'ReadKey, ChangePermissions'
    $granted = 0
    $failed = 0
    $stack = New-Object System.Collections.Stack
    $stack.Push($HiveMount)
    while ($stack.Count -gt 0) {
        $path = [string]$stack.Pop()
        $key = $null
        try {
            $key = [Microsoft.Win32.Registry]::Users.OpenSubKey($path, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, $rights)
            if ($null -eq $key) { continue }
            $acl = $key.GetAccessControl()
            if ($path -eq $HiveMount -or $acl.AreAccessRulesProtected) {
                $acl.AddAccessRule($rule)
                $key.SetAccessControl($acl)
                $granted++
            }
            foreach ($name in $key.GetSubKeyNames()) { $stack.Push($path + '\' + $name) }
        } catch { $failed++ }
        finally { if ($key) { $key.Close() } }
    }
    return [pscustomobject]@{ Granted = $granted; Failed = $failed }
}

# Remove a hive key after exporting it, so the restore can put it back.
function Remove-HiveKey([string]$SubPath, [string]$ExportFile) {
    $full = "Registry::HKEY_USERS\$HiveMount\$SubPath"
    if (-not (Test-Path $full)) { return $false }
    $r = Invoke-Native 'reg.exe' @('export', "HKU\$HiveMount\$SubPath", $ExportFile, '/y')
    if ($r.ExitCode -ne 0) { throw "Could not back up $SubPath before clearing it: $($r.Output)" }
    Remove-Item -Path $full -Recurse -Force
    return $true
}

function Update-Hive([string]$File, [string]$Sid, [string]$BackupDir, [string]$Label, [bool]$ClearIdentities) {
    if (-not (Test-Path -LiteralPath $File)) { return "$Label not found" }
    Mount-Hive $File
    try {
        $r = Grant-HiveAccess $Sid
        $removed = @()
        if ($ClearIdentities) {
            # Cached sign-ins for the old tenant: Office and OneDrive re-prompt for the new account.
            $officeKeys = @(Get-ChildItem -Path "Registry::HKEY_USERS\$HiveMount\Software\Microsoft\Office" -ErrorAction SilentlyContinue |
                Where-Object { $_.PSChildName -match '^\d+\.\d+$' })
            $i = 0
            foreach ($k in $officeKeys) {
                $sub = "Software\Microsoft\Office\$($k.PSChildName)\Common\Identity"
                if (Remove-HiveKey $sub (Join-Path $BackupDir "hive-office-$i.reg")) { $removed += "Office $($k.PSChildName) identity" }
                $i++
            }
            $odAccounts = @(Get-ChildItem -Path "Registry::HKEY_USERS\$HiveMount\Software\Microsoft\OneDrive\Accounts" -ErrorAction SilentlyContinue |
                Where-Object { $_.PSChildName -like 'Business*' })
            foreach ($k in $odAccounts) {
                $sub = "Software\Microsoft\OneDrive\Accounts\$($k.PSChildName)"
                if (Remove-HiveKey $sub (Join-Path $BackupDir "hive-onedrive-$($k.PSChildName).reg")) { $removed += "OneDrive $($k.PSChildName)" }
            }
        }
        $msg = "$Label`: access granted on $($r.Granted) key(s)"
        if ($r.Failed -gt 0) { $msg += ", $($r.Failed) key(s) could not be updated" }
        if ($removed.Count -gt 0) { $msg += '; cleared ' + ($removed -join ', ') }
        return $msg
    } finally { Dismount-Hive }
}

$IdentityCaches = @(
    'AppData\Local\Packages\Microsoft.AAD.BrokerPlugin_cw5n1h2txyewy',
    'AppData\Local\Microsoft\TokenBroker',
    'AppData\Local\Microsoft\IdentityCache',
    'AppData\Local\Microsoft\OneAuth'
)

function Invoke-ProfileHandover($Plan, $Ctx, [string]$BackupDir) {
    $oldSid = $Plan.sourceUser.sid
    $newSid = $Plan.destUser.sid
    $src = $Ctx.SourceProfile
    $notes = @()

    # 1. Registry: the profile now belongs to the new SID. Values are copied
    #    with their exact registry types; only the binary Sid value changes.
    $rel = 'SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
    $hklm = [Microsoft.Win32.Registry]::LocalMachine
    $oldKey = $hklm.OpenSubKey("$rel\$oldSid")
    $newKey = $hklm.CreateSubKey("$rel\$newSid")
    try {
        foreach ($name in $oldKey.GetValueNames()) {
            if ($name -eq 'Sid') { continue }
            $value = $oldKey.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $newKey.SetValue($name, $value, $oldKey.GetValueKind($name))
        }
        $newKey.SetValue('Sid', [byte[]](Get-SidBytes $newSid), [Microsoft.Win32.RegistryValueKind]::Binary)
    } finally {
        $oldKey.Close()
        $newKey.Close()
    }
    Remove-Item -Path $src.RegPath -Recurse -Force
    $guidRoot = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileGuid'
    foreach ($g in @(Get-ChildItem -Path $guidRoot -ErrorAction SilentlyContinue)) {
        if ($g.GetValue('SidString', $null) -eq $oldSid) {
            Set-ItemProperty -Path $g.PSPath -Name 'SidString' -Value $newSid
        }
    }
    $notes += 'profile list updated'

    # 2. Files: grant the new account full control of the profile folder.
    $grant = '*' + $newSid + ':(OI)(CI)F'
    $r = Invoke-Native 'icacls.exe' @($src.ImagePath, '/grant', $grant, '/T', '/C', '/Q')
    if ($r.ExitCode -ne 0) { $notes += 'some files could not be updated (icacls exit ' + $r.ExitCode + ')' }
    else { $notes += 'profile folder permissions updated' }
    foreach ($f in @('NTUSER.DAT', 'AppData\Local\Microsoft\Windows\UsrClass.dat')) {
        $p = Join-Path $src.ImagePath $f
        if (Test-Path -LiteralPath $p) { Invoke-Native 'icacls.exe' @($p, '/setowner', ('*' + $newSid), '/C', '/Q') | Out-Null }
    }

    # 3. Registry hives: grant access, clear cached old-tenant sign-ins.
    $notes += Update-Hive (Join-Path $src.ImagePath 'NTUSER.DAT') $newSid $BackupDir 'NTUSER.DAT' $true
    $notes += Update-Hive (Join-Path $src.ImagePath 'AppData\Local\Microsoft\Windows\UsrClass.dat') $newSid $BackupDir 'UsrClass.dat' $false

    # 4. Token caches for the old tenant: set aside (restorable), Windows rebuilds them.
    $moved = 0
    foreach ($rel in $IdentityCaches) {
        $p = Join-Path $src.ImagePath $rel
        if (Test-Path -LiteralPath $p) {
            try { Rename-Item -LiteralPath $p -NewName ((Split-Path $p -Leaf) + '.dolop-old') -Force; $moved++ }
            catch { $notes += "could not set aside $rel" }
        }
    }
    $notes += "$moved sign-in cache folder(s) set aside"
    return ($notes -join '; ')
}

function Restore-Profile([string]$BackupDir) {
    if (-not $BackupDir -or -not (Test-Path (Join-Path $BackupDir 'context.json'))) { throw 'No profile backup found' }
    $ctx = Get-Content -Path (Join-Path $BackupDir 'context.json') -Raw | ConvertFrom-Json
    $r = Invoke-Native 'reg.exe' @('import', (Join-Path $BackupDir 'profilelist.reg'))
    if ($r.ExitCode -ne 0) { throw "Could not re-import the profile list backup: $($r.Output)" }
    $newPath = Join-Path $ProfileListPath $ctx.destSid
    if (Test-Path $newPath) { Remove-Item -Path $newPath -Recurse -Force }
    $guidRoot = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileGuid'
    foreach ($g in @(Get-ChildItem -Path $guidRoot -ErrorAction SilentlyContinue)) {
        if ($g.GetValue('SidString', $null) -eq $ctx.destSid) { Set-ItemProperty -Path $g.PSPath -Name 'SidString' -Value $ctx.sourceSid }
    }
    $hiveExports = @(Get-ChildItem -Path $BackupDir -Filter 'hive-*.reg' -ErrorAction SilentlyContinue)
    if ($hiveExports.Count -gt 0) {
        Mount-Hive (Join-Path $ctx.profilePath 'NTUSER.DAT')
        try { foreach ($f in $hiveExports) { Invoke-Native 'reg.exe' @('import', $f.FullName) | Out-Null } }
        finally { Dismount-Hive }
    }
    foreach ($rel in $IdentityCaches) {
        $aside = (Join-Path $ctx.profilePath $rel) + '.dolop-old'
        $orig = Join-Path $ctx.profilePath $rel
        if ((Test-Path -LiteralPath $aside) -and -not (Test-Path -LiteralPath $orig)) {
            Rename-Item -LiteralPath $aside -NewName (Split-Path $orig -Leaf) -Force
        }
    }
    # Permissions granted to the new SID are additive and harmless; they are left in place.
    return "profile restored to $($ctx.sourceUpn)"
}

# ---------------------------------------------------------------------------
# Leaving and joining tenants

function Remove-MdmEnrollment([string]$EnrollmentId) {
    $sig = '[DllImport("mdmregistration.dll", CharSet = CharSet.Unicode)] public static extern int UnregisterDeviceWithManagement(string enrollmentID);'
    if (-not ('Dolop.Mdm' -as [type])) { Add-Type -Namespace Dolop -Name Mdm -MemberDefinition $sig }
    $hr = [Dolop.Mdm]::UnregisterDeviceWithManagement($EnrollmentId)
    if ($hr -eq 0) { return 'unenrolled' }

    # Fallback: remove the enrollment's local footprint (what Settings > Disconnect does).
    $tasks = "\Microsoft\Windows\EnterpriseMgmt\$EnrollmentId\"
    Get-ScheduledTask -TaskPath $tasks -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue
    foreach ($k in @(
            "HKLM:\SOFTWARE\Microsoft\Enrollments\$EnrollmentId",
            "HKLM:\SOFTWARE\Microsoft\Enrollments\Status\$EnrollmentId",
            "HKLM:\SOFTWARE\Microsoft\EnterpriseResourceManager\Tracked\$EnrollmentId",
            "HKLM:\SOFTWARE\Microsoft\PolicyManager\AdmxInstalled\$EnrollmentId",
            "HKLM:\SOFTWARE\Microsoft\PolicyManager\Providers\$EnrollmentId",
            "HKLM:\SOFTWARE\Microsoft\Provisioning\OMADM\Accounts\$EnrollmentId",
            "HKLM:\SOFTWARE\Microsoft\Provisioning\OMADM\Logger\$EnrollmentId",
            "HKLM:\SOFTWARE\Microsoft\Provisioning\OMADM\Sessions\$EnrollmentId")) {
        if (Test-Path $k) { Remove-Item -Path $k -Recurse -Force -ErrorAction SilentlyContinue }
    }
    return ('removed locally (unregister returned 0x{0:X8})' -f $hr)
}

function Wait-Join([string]$TenantId, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        $d = Get-Dsreg
        if ((Get-DsregValue $d 'AzureAdJoined') -eq 'YES' -and (Test-SameGuid (Get-DsregValue $d 'TenantId') $TenantId)) { return $true }
        Start-Sleep -Seconds 10
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Stop-UserSessions([string]$Sid) {
    foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'")) {
        try {
            $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid
            if ($owner.Sid -eq $Sid) { Invoke-Native 'logoff.exe' @([string]$p.SessionId) | Out-Null }
        } catch { }
    }
    for ($i = 0; $i -lt 24 -and (Test-HiveLoaded $Sid); $i++) { Start-Sleep -Seconds 5 }
}

function Register-AgentTask([string]$Name, [string]$Arguments, $Trigger) {
    $script = Join-Path $Root 'dolop-agent.ps1'
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument ("-NoProfile -ExecutionPolicy Bypass -File `"$script`" -Server `"$Server`" " + $Arguments)
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Hours 3)
    Register-ScheduledTask -TaskName $Name -TaskPath $TaskPath -Action $action -Trigger $Trigger `
        -Principal $principal -Settings $settings -Force | Out-Null
}

function Remove-AgentTask([string]$Name) {
    Unregister-ScheduledTask -TaskName $Name -TaskPath $TaskPath -Confirm:$false -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# Modes

function Invoke-CheckMode {
    $plan = Get-Plan
    Write-Log "Checking $env:COMPUTERNAME for $($plan.sourceUser.upn) -> $($plan.destUser.upn)"
    $r = Invoke-Checks $plan $false
    Show-Checks $r
    $data = @{}
    if ($r.Context.ProfilePath) { $data.profilePath = $r.Context.ProfilePath }
    $summary = if ($r.Failed -gt 0) { "$($r.Failed) check(s) failed" } else { 'All checks passed' }
    Send-Report -Phase 'check' -Step 'preflight' -Status 'done' -Detail $summary -Checks $r.Checks -Data $data -BitLocker $r.Context.BitLocker.Keys
    if ($r.Failed -gt 0) { exit 1 }
}

function Invoke-ScheduleMode {
    Initialize-Root
    $plan = Get-Plan
    $r = Invoke-Checks $plan $false
    Show-Checks $r
    Send-Report -Phase 'check' -Step 'preflight' -Status 'done' -Detail ("Before scheduling: " + $(if ($r.Failed) { "$($r.Failed) check(s) failed" } else { 'all checks passed' })) `
        -Checks $r.Checks -BitLocker $r.Context.BitLocker.Keys
    if ($r.Failed -gt 0) { Write-Log 'Fix the failed checks, then schedule again.' 'ERROR'; exit 1 }

    $when = (Get-Date).AddMinutes(2)
    if ($At) {
        $when = [datetime]::Parse($At)
        if ($when -lt (Get-Date)) { throw "-At $At is in the past" }
    }

    # Everything the SYSTEM task needs, kept where only SYSTEM and admins can read it.
    $scriptFile = Join-Path $Root 'dolop-agent.ps1'
    Invoke-WebRequest -Uri ($Server + '/api/agent/script') -OutFile $scriptFile -UseBasicParsing | Out-Null
    Set-Content -Path (Join-Path $Root 'token') -Value (Get-AgentToken) -NoNewline -Encoding ASCII
    if ($r.Context.JoinMode -eq 'package') {
        $pkg = Join-Path $Root 'package.ppkg'
        Invoke-Dolop 'GET' '/api/agent/package' -OutFile $pkg
        $hash = (Get-FileHash -Path $pkg -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($plan.package.sha256 -and $hash -ne $plan.package.sha256) { throw 'Provisioning package download is corrupt (hash mismatch)' }
    }

    $extra = '-Mode Migrate'
    if ($ForceLogoff) { $extra += ' -ForceLogoff' }
    if ($SkipLocalAdminCheck) { $extra += ' -SkipLocalAdminCheck' }
    if ($ManualJoin) { $extra += ' -ManualJoin' }
    Register-AgentTask $TaskMigrate $extra (New-ScheduledTaskTrigger -Once -At $when)
    $whenText = $when.ToString('yyyy-MM-dd HH:mm')
    Send-Report -Phase 'schedule' -Step 'scheduled' -Status 'ok' -Detail "Migration scheduled for $whenText (device local time)" `
        -Data @{ scheduledFor = $when.ToUniversalTime().ToString('o') }
    Write-Host ''
    Write-Host "Scheduled for $whenText. If the device is off then, it runs as soon as it starts." -ForegroundColor Green
    Write-Host "Make sure $($plan.sourceUser.upn) is signed out by then (or schedule with -ForceLogoff)." -ForegroundColor Green
    if ($r.Context.JoinMode -eq 'manual') {
        Write-Host 'Manual join: after the device restarts, sign in with the local admin account and join it to the' -ForegroundColor Yellow
        Write-Host 'destination tenant in Settings > Accounts > Access work or school > Connect.' -ForegroundColor Yellow
    } else {
        Write-Host 'The device restarts by itself when the migration is done. Progress shows in dolop.' -ForegroundColor Green
    }
}

function Invoke-UnscheduleMode {
    Remove-AgentTask $TaskMigrate
    Send-Report -Phase 'schedule' -Step 'unscheduled' -Status 'info' -Detail 'Scheduled migration removed'
    Remove-Item -Path (Join-Path $Root 'package.ppkg') -Force -ErrorAction SilentlyContinue
}

function Invoke-MigrateMode {
    Initialize-Root
    $plan = Get-Plan
    Send-Report -Phase 'migrate' -Step 'start' -Status 'info' -Detail "Starting on $env:COMPUTERNAME"

    if ($ForceLogoff -and (Test-HiveLoaded $plan.sourceUser.sid)) {
        Send-Report -Phase 'migrate' -Step 'signout' -Status 'info' -Detail "Signing $($plan.sourceUser.upn) out"
        Stop-UserSessions $plan.sourceUser.sid
    }
    $r = Invoke-Checks $plan $true
    if ($r.Failed -gt 0) {
        $failed = ($r.Checks | Where-Object { $_.status -eq 'fail' } | ForEach-Object { "$($_.name): $($_.detail)" }) -join '; '
        Send-Report -Phase 'migrate' -Step 'preflight' -Status 'fail' -Detail "Nothing was changed. $failed" -Checks $r.Checks
        Remove-AgentTask $TaskMigrate
        exit 1
    }
    $ctx = $r.Context
    $resumeJoin = $ctx.Unjoined -and $ctx.AlreadyMapped
    if ($ctx.DestJoined) {
        Send-Report -Phase 'migrate' -Step 'joined' -Status 'ok' -Detail 'Already joined to the destination tenant'
    } elseif ($resumeJoin) {
        Send-Report -Phase 'migrate' -Step 'resume' -Status 'info' -Detail 'Profile already handed over and source tenant already left: joining the destination'
    } elseif (-not $ctx.SourceJoined) {
        Send-Report -Phase 'migrate' -Step 'preflight' -Status 'fail' -Detail 'Device is not joined to the source tenant'
        exit 1
    }

    if (-not $ctx.DestJoined -and -not $resumeJoin) {
        # --- Backup ---
        $backup = Join-Path $Root ('backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        New-Item -ItemType Directory -Path $backup -Force | Out-Null
        if (-not $ctx.AlreadyMapped) {
            $r = Invoke-Native 'reg.exe' @('export', 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList', (Join-Path $backup 'profilelist.reg'), '/y')
            if ($r.ExitCode -ne 0) {
                Send-Report -Phase 'migrate' -Step 'backup' -Status 'fail' -Detail 'Could not back up the profile list; nothing was changed'
                exit 1
            }
        }
        $groups = @()
        try { $groups = Get-LocalGroupsOf $plan.sourceUser.sid } catch { }
        $context = @{
            sourceUpn = $plan.sourceUser.upn; sourceSid = $plan.sourceUser.sid
            destUpn = $plan.destUser.upn; destSid = $plan.destUser.sid
            profilePath = $ctx.ProfilePath; groups = $groups; created = (Get-Date).ToString('o')
        }
        $context | ConvertTo-Json | Set-Content -Path (Join-Path $backup 'context.json') -Encoding UTF8
        Send-Report -Phase 'migrate' -Step 'backup' -Status 'ok' -Detail "Backup saved to $backup" `
            -Data @{ backupPath = $backup; localGroups = ($groups -join ', ') } -BitLocker $ctx.BitLocker.Keys

        # --- Profile hand-over (undone automatically on failure) ---
        if (-not $ctx.AlreadyMapped) {
            try {
                $notes = Invoke-ProfileHandover $plan $ctx $backup
                Send-Report -Phase 'migrate' -Step 'profile' -Status 'ok' -Detail $notes
            } catch {
                $err = $_.Exception.Message
                $undo = try { Restore-Profile $backup } catch { "restore also failed: $($_.Exception.Message)" }
                Send-Report -Phase 'migrate' -Step 'profile' -Status 'fail' -Detail "Profile hand-over failed ($err); $undo. The device is unchanged otherwise."
                Remove-AgentTask $TaskMigrate
                exit 1
            }
        }

        # --- Leave the source tenant ---
        try {
            $mdm = @()
            foreach ($e in $ctx.Enrollments) { $mdm += "Intune ${e}: " + (Remove-MdmEnrollment $e) }
            Invoke-Native 'dsregcmd.exe' @('/leave') | Out-Null
            Start-Sleep -Seconds 10
            $d = Get-Dsreg
            if ((Get-DsregValue $d 'AzureAdJoined') -eq 'YES') { throw 'dsregcmd /leave did not take effect' }
            Send-Report -Phase 'migrate' -Step 'left_source' -Status 'ok' -Detail ('Left the source tenant. ' + ($mdm -join '; '))
        } catch {
            $err = $_.Exception.Message
            $undo = try { Restore-Profile $backup } catch { "profile restore failed: $($_.Exception.Message)" }
            Send-Report -Phase 'migrate' -Step 'left_source' -Status 'fail' -Detail ("Could not leave the source tenant ($err); $undo. The user can sign in with their old account. " +
                'If the Intune enrollment was already removed, re-enroll the device or try again.')
            Remove-AgentTask $TaskMigrate
            exit 1
        }

    }

    if (-not $ctx.DestJoined -and $ctx.JoinMode -eq 'manual') {
        # --- Manual join: hand over to a person, then finish when the join shows up ---
        Set-Content -Path (Join-Path $Root 'manual-join') -Value (Get-Date).ToString('o')
        $atStartup = New-ScheduledTaskTrigger -AtStartup
        $atStartup.Delay = 'PT1M'
        $poll = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) `
            -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days $ManualJoinDays)
        Register-AgentTask $TaskPostJoin '-Mode PostJoin -ManualJoin' @($atStartup, $poll)
        Remove-AgentTask $TaskMigrate
        Send-Report -Phase 'migrate' -Step 'awaiting_join' -Status 'ok' -Detail ("Left the source tenant; the profile is handed over. After the restart, sign in with the local admin account, " +
            "open Settings > Accounts > Access work or school > Connect > Join this device to Microsoft Entra ID, and sign in as $($plan.destUser.upn) (or a destination admin). " +
            "Then sign out: $($plan.destUser.upn) signs in to their own desktop. dolop finishes automatically within 10 minutes of the join.")
        Invoke-Native 'shutdown.exe' @('/r', '/t', '60', '/c', 'This device is leaving your old organisation and will restart in one minute. Your IT team will then connect it to your new organisation.') | Out-Null
        return
    }

    if (-not $ctx.DestJoined) {
        # --- Join the destination tenant ---
        $pkg = Join-Path $Root 'package.ppkg'
        try {
            if (-not (Test-Path $pkg)) { Invoke-Dolop 'GET' '/api/agent/package' -OutFile $pkg }
            $hash = (Get-FileHash -Path $pkg -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($plan.package.sha256 -and $hash -ne $plan.package.sha256) {
                Invoke-Dolop 'GET' '/api/agent/package' -OutFile $pkg
            }
            Install-ProvisioningPackage -PackagePath $pkg -ForceInstall -QuietInstall | Out-Null
        } catch {
            Send-Report -Phase 'migrate' -Step 'join' -Status 'fail' -Detail ("Left the source tenant but the provisioning package failed: $($_.Exception.Message). " +
                'Sign in with the local admin account and join the destination tenant in Settings > Accounts > Access work or school; the user''s profile is already handed over.')
            Remove-AgentTask $TaskMigrate
            exit 1
        }
        if (-not (Wait-Join $plan.destTenantId 600)) {
            Send-Report -Phase 'migrate' -Step 'join' -Status 'fail' -Detail ('The package installed but the device did not join the destination tenant within 10 minutes. ' +
                'Check the package (bulk token expiry) and join manually in Settings > Accounts > Access work or school; the user''s profile is already handed over.')
            Remove-AgentTask $TaskMigrate
            exit 1
        }
        Send-Report -Phase 'migrate' -Step 'joined' -Status 'ok' -Detail 'Joined the destination tenant'
    }

    # --- Finish after a restart ---
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $trigger.Delay = 'PT1M'
    Register-AgentTask $TaskPostJoin '-Mode PostJoin' $trigger
    Remove-AgentTask $TaskMigrate
    Send-Report -Phase 'migrate' -Step 'restart' -Status 'info' -Detail 'Restarting to finish'
    Invoke-Native 'shutdown.exe' @('/r', '/t', '60', '/c', 'Your device is moving to your new organisation. It will restart in one minute. Sign in with your new work account.') | Out-Null
}

function Invoke-PostJoinMode {
    $attemptsFile = Join-Path $Root 'postjoin-attempts'
    $manualFile = Join-Path $Root 'manual-join'
    $manual = $ManualJoin -or (Test-Path $manualFile)

    if ($manual) {
        # Polled every 10 minutes: cheap local check first, quietly wait until someone joins.
        $d = Get-Dsreg
        if ((Get-DsregValue $d 'AzureAdJoined') -ne 'YES') {
            $since = Get-Date
            try { $since = [datetime]::Parse((Get-Content $manualFile -Raw).Trim()) } catch { }
            if (((Get-Date) - $since).TotalDays -ge $ManualJoinDays) {
                Remove-AgentTask $TaskPostJoin
                Send-Report -Phase 'postjoin' -Step 'verify' -Status 'fail' -Detail "Nobody joined the device to the destination tenant within $ManualJoinDays days. Join it in Settings, then mark it done in dolop."
                exit 1
            }
            Write-Log 'Waiting for the device to be joined to the destination tenant by hand'
            exit 0
        }
    } else {
        $attempt = 1
        if (Test-Path $attemptsFile) { $attempt = 1 + [int]((Get-Content $attemptsFile -Raw).Trim()) }
        Set-Content -Path $attemptsFile -Value $attempt
    }

    $plan = $null
    $tries = if ($manual) { 3 } else { 30 }
    for ($i = 0; $i -lt $tries -and $null -eq $plan; $i++) {
        try { $plan = Get-Plan } catch { Start-Sleep -Seconds 20 }
    }
    if ($null -eq $plan) { Write-Log 'dolop is unreachable; will retry later' 'ERROR'; exit 1 }

    if ($manual) {
        if (-not (Wait-Join $plan.destTenantId 30)) {
            $d = Get-Dsreg
            Remove-AgentTask $TaskPostJoin
            Send-Report -Phase 'postjoin' -Step 'verify' -Status 'fail' -Detail "The device was joined to a different tenant ($(Get-DsregValue $d 'TenantId')), not the destination."
            exit 1
        }
    } elseif (-not (Wait-Join $plan.destTenantId 300)) {
        $detail = "Not joined to the destination tenant after restart (attempt $attempt)."
        if ($attempt -ge 3) { Remove-AgentTask $TaskPostJoin; $detail += ' Giving up: join it manually in Settings.' }
        Send-Report -Phase 'postjoin' -Step 'verify' -Status 'fail' -Detail $detail
        exit 1
    }
    $notes = @()

    # BitLocker keys: back them up to the new tenant (the old tenant's copy goes with it).
    $bl = Get-RecoveryPasswords
    $escrowed = 0
    foreach ($k in $bl.Keys) {
        try { BackupToAAD-BitLockerKeyProtector -MountPoint $env:SystemDrive -KeyProtectorId ('{' + $k.id + '}') | Out-Null; $escrowed++ }
        catch { $notes += "BitLocker key $($k.id) not backed up to the new tenant: $($_.Exception.Message)" }
    }
    if ($bl.Keys.Count -gt 0) { $notes += "$escrowed of $($bl.Keys.Count) BitLocker key(s) backed up to the new tenant" }

    # Local group memberships the old account had (e.g. local Administrators).
    $backup = Get-LatestBackup
    if ($backup) {
        try {
            $ctx = Get-Content -Path (Join-Path $backup 'context.json') -Raw | ConvertFrom-Json
            foreach ($g in @($ctx.groups)) {
                if (-not $g) { continue }
                $r = Invoke-Native 'net.exe' @('localgroup', $g, ("AzureAD\" + $plan.destUser.upn), '/add')
                if ($r.ExitCode -eq 0) { $notes += "added to local group $g" }
                elseif ($r.Output -match '1378') { $notes += "already in local group $g" }
                else { $notes += "could not add to local group $g (exit $($r.ExitCode))" }
            }
        } catch { $notes += "local groups not restored: $($_.Exception.Message)" }
    }

    Remove-AgentTask $TaskPostJoin
    # The package carries the destination enrollment token; the token is spent.
    Remove-Item -Path (Join-Path $Root 'package.ppkg'), $attemptsFile, $manualFile -Force -ErrorAction SilentlyContinue
    Send-Report -Phase 'postjoin' -Step 'done' -Status 'done' -Detail ('Migration complete. ' + ($notes -join '; ')) -BitLocker $bl.Keys
    Remove-Item -Path (Join-Path $Root 'token') -Force -ErrorAction SilentlyContinue
}

function Invoke-RestoreMode {
    $backup = Get-LatestBackup
    if (-not $backup) { throw "No backup found under $Root" }
    $d = Get-Dsreg
    if ((Get-DsregValue $d 'AzureAdJoined') -ne 'YES') {
        Write-Log 'This device is not joined to any tenant: the old account will not be able to sign in until it is joined again.' 'WARN'
    }
    $msg = Restore-Profile $backup
    Send-Report -Phase 'restore' -Step 'profile' -Status 'warn' -Detail $msg
}

# ---------------------------------------------------------------------------

try {
    if ($Mode -ne 'Check' -and -not (Test-Elevated)) { throw 'Run PowerShell as administrator.' }
    if (Test-Elevated) { Initialize-Root }
    Write-Log "dolop agent $AgentVersion, mode $Mode, server $Server"
    switch ($Mode) {
        'Check' { Invoke-CheckMode }
        'Schedule' { Invoke-ScheduleMode }
        'Unschedule' { Invoke-UnscheduleMode }
        'Migrate' { Invoke-MigrateMode }
        'PostJoin' { Invoke-PostJoinMode }
        'RestoreProfile' { Invoke-RestoreMode }
    }
} catch {
    $msg = $_.Exception.Message
    Write-Log $msg 'ERROR'
    $phase = switch ($Mode) { 'Check' { 'check' } 'Schedule' { 'schedule' } 'PostJoin' { 'postjoin' } 'RestoreProfile' { 'restore' } default { 'migrate' } }
    if ($Mode -ne 'Check') {
        Send-Report -Phase $phase -Step 'error' -Status 'fail' -Detail $msg
    } else {
        Send-Report -Phase 'check' -Step 'error' -Status 'info' -Detail "Check could not finish: $msg"
    }
    exit 1
}
