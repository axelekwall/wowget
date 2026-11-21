# One-time conversion of the Bun client's TOML manifest to wowget.json (SPEC-POWERSHELL.md, "TOML
# import"). The reader covers TOML 1.0 except dates and times, which no manifest key takes.
#
# Tables are case-sensitive ordered dictionaries, arrays are List[object], integers [long], floats
# [double]. Errors are "manifest" errors naming the line.

function New-WowgetTomlTable {
    return [System.Collections.Specialized.OrderedDictionary]::new([System.StringComparer]::Ordinal)
}

function New-WowgetTomlError {
    param([Parameter(Mandatory)]$P, [Parameter(Mandatory)][string]$Message, [int]$At = -1)
    $pos = if ($At -ge 0) { $At } else { $P.Pos }
    $pos = [Math]::Min($pos, $P.Text.Length)
    $line = 1
    for ($k = 0; $k -lt $pos; $k++) { if ($P.Text[$k] -eq "`n") { $line++ } }
    return New-WowgetError 'manifest' "$($P.Prefix)line ${line}: $Message"
}

function Get-WowgetTomlChar {
    param([Parameter(Mandatory)]$P, [int]$Offset = 0)
    $k = $P.Pos + $Offset
    if ($k -ge $P.Text.Length) { return [char]0 }
    return $P.Text[$k]
}

function Test-WowgetTomlEnd { param([Parameter(Mandatory)]$P) return $P.Pos -ge $P.Text.Length }

function Skip-WowgetTomlSpace {
    param([Parameter(Mandatory)]$P)
    while ($P.Pos -lt $P.Text.Length -and ($P.Text[$P.Pos] -eq ' ' -or $P.Text[$P.Pos] -eq "`t")) { $P.Pos++ }
}

# A comment runs to the end of the line; control characters other than tab are not allowed in it.
function Skip-WowgetTomlComment {
    param([Parameter(Mandatory)]$P)
    if ((Get-WowgetTomlChar $P) -ne '#') { return }
    $P.Pos++
    while (-not (Test-WowgetTomlEnd $P)) {
        $c = $P.Text[$P.Pos]
        if ($c -eq "`n" -or ($c -eq "`r" -and (Get-WowgetTomlChar $P 1) -eq "`n")) { return }
        if (([int]$c -lt 0x20 -and $c -ne "`t") -or [int]$c -eq 0x7f) { throw (New-WowgetTomlError $P 'control character in a comment') }
        $P.Pos++
    }
}

# Consumes a newline; returns whether there was one.
function Read-WowgetTomlNewline {
    param([Parameter(Mandatory)]$P)
    $c = Get-WowgetTomlChar $P
    if ($c -eq "`n") { $P.Pos++; return $true }
    if ($c -eq "`r" -and (Get-WowgetTomlChar $P 1) -eq "`n") { $P.Pos += 2; return $true }
    return $false
}

# Skips whitespace, newlines and comments, as allowed between array elements.
function Skip-WowgetTomlBlank {
    param([Parameter(Mandatory)]$P)
    while ($true) {
        Skip-WowgetTomlSpace $P
        Skip-WowgetTomlComment $P
        if (-not (Read-WowgetTomlNewline $P)) { return }
    }
}

function Assert-WowgetTomlLineEnd {
    param([Parameter(Mandatory)]$P)
    Skip-WowgetTomlSpace $P
    Skip-WowgetTomlComment $P
    if (Test-WowgetTomlEnd $P) { return }
    if (-not (Read-WowgetTomlNewline $P)) { throw (New-WowgetTomlError $P "expected the end of the line, found '$(Get-WowgetTomlChar $P)'") }
}

function Test-WowgetTomlBareKeyChar {
    param([char]$C)
    return ($C -ge 'a' -and $C -le 'z') -or ($C -ge 'A' -and $C -le 'Z') -or ($C -ge '0' -and $C -le '9') -or $C -eq '_' -or $C -eq '-'
}

function Read-WowgetTomlSimpleKey {
    param([Parameter(Mandatory)]$P)
    $c = Get-WowgetTomlChar $P
    if ($c -eq '"') {
        if ((Get-WowgetTomlChar $P 1) -eq '"' -and (Get-WowgetTomlChar $P 2) -eq '"') { throw (New-WowgetTomlError $P 'a key cannot be a multi-line string') }
        return Read-WowgetTomlBasicString $P
    }
    if ($c -eq "'") {
        if ((Get-WowgetTomlChar $P 1) -eq "'" -and (Get-WowgetTomlChar $P 2) -eq "'") { throw (New-WowgetTomlError $P 'a key cannot be a multi-line string') }
        return Read-WowgetTomlLiteralString $P
    }
    $start = $P.Pos
    while (-not (Test-WowgetTomlEnd $P) -and (Test-WowgetTomlBareKeyChar $P.Text[$P.Pos])) { $P.Pos++ }
    if ($P.Pos -eq $start) { throw (New-WowgetTomlError $P "expected a key, found '$c'") }
    return $P.Text.Substring($start, $P.Pos - $start)
}

function Read-WowgetTomlKey {
    param([Parameter(Mandatory)]$P)
    $parts = [System.Collections.Generic.List[string]]::new()
    $parts.Add((Read-WowgetTomlSimpleKey $P))
    while ($true) {
        $save = $P.Pos
        Skip-WowgetTomlSpace $P
        if ((Get-WowgetTomlChar $P) -ne '.') { $P.Pos = $save; break }
        $P.Pos++
        Skip-WowgetTomlSpace $P
        $parts.Add((Read-WowgetTomlSimpleKey $P))
    }
    return , $parts.ToArray()
}

function Test-WowgetTomlControl {
    param([char]$C)
    return ([int]$C -lt 0x20 -and $C -ne "`t") -or [int]$C -eq 0x7f
}

function Read-WowgetTomlEscape {
    param([Parameter(Mandatory)]$P, [Parameter(Mandatory)][System.Text.StringBuilder]$Sb)
    $at = $P.Pos
    $P.Pos++
    $e = Get-WowgetTomlChar $P
    $P.Pos++
    switch -CaseSensitive ($e) {
        'b' { [void]$Sb.Append("`b"); return }
        't' { [void]$Sb.Append("`t"); return }
        'n' { [void]$Sb.Append("`n"); return }
        'f' { [void]$Sb.Append("`f"); return }
        'r' { [void]$Sb.Append("`r"); return }
        '"' { [void]$Sb.Append('"'); return }
        '\' { [void]$Sb.Append('\'); return }
        { $_ -ceq 'u' -or $_ -ceq 'U' } {
            $len = if ($e -ceq 'u') { 4 } else { 8 }
            $hex = if ($P.Pos + $len -le $P.Text.Length) { $P.Text.Substring($P.Pos, $len) } else { '' }
            if ($hex -notmatch '^[0-9A-Fa-f]+$' -or $hex.Length -ne $len) { throw (New-WowgetTomlError $P "invalid \$e escape" $at) }
            $code = [Convert]::ToInt64($hex, 16)
            if ($code -gt 0x10FFFF -or ($code -ge 0xD800 -and $code -le 0xDFFF)) { throw (New-WowgetTomlError $P "\$e$hex is not a Unicode scalar value" $at) }
            [void]$Sb.Append([char]::ConvertFromUtf32([int]$code))
            $P.Pos += $len
            return
        }
    }
    throw (New-WowgetTomlError $P "invalid escape \$e" $at)
}

function Read-WowgetTomlBasicString {
    param([Parameter(Mandatory)]$P)
    $start = $P.Pos
    $P.Pos++
    $sb = [System.Text.StringBuilder]::new()
    while ($true) {
        if (Test-WowgetTomlEnd $P) { throw (New-WowgetTomlError $P 'unterminated string' $start) }
        $c = $P.Text[$P.Pos]
        if ($c -eq '"') { $P.Pos++; return $sb.ToString() }
        if ($c -eq '\') { Read-WowgetTomlEscape $P $sb; continue }
        if ($c -eq "`n" -or $c -eq "`r") { throw (New-WowgetTomlError $P 'newline in a single-line string' $start) }
        if (Test-WowgetTomlControl $c) { throw (New-WowgetTomlError $P 'control character in a string') }
        [void]$sb.Append($c)
        $P.Pos++
    }
}

function Read-WowgetTomlLiteralString {
    param([Parameter(Mandatory)]$P)
    $start = $P.Pos
    $P.Pos++
    $from = $P.Pos
    while ($true) {
        if (Test-WowgetTomlEnd $P) { throw (New-WowgetTomlError $P 'unterminated string' $start) }
        $c = $P.Text[$P.Pos]
        if ($c -eq "'") { $value = $P.Text.Substring($from, $P.Pos - $from); $P.Pos++; return $value }
        if ($c -eq "`n" -or $c -eq "`r") { throw (New-WowgetTomlError $P 'newline in a single-line string' $start) }
        if (Test-WowgetTomlControl $c) { throw (New-WowgetTomlError $P 'control character in a string') }
        $P.Pos++
    }
}

# Multi-line strings: a newline right after the opening delimiter is dropped, and up to two quotes may
# come right before the closing delimiter. $Basic enables escapes and line-ending backslashes.
function Read-WowgetTomlMultilineString {
    param([Parameter(Mandatory)]$P, [Parameter(Mandatory)][char]$Quote, [bool]$Basic)
    $start = $P.Pos
    $P.Pos += 3
    [void](Read-WowgetTomlNewline $P)
    $sb = [System.Text.StringBuilder]::new()
    while ($true) {
        if (Test-WowgetTomlEnd $P) { throw (New-WowgetTomlError $P 'unterminated multi-line string' $start) }
        $c = $P.Text[$P.Pos]
        if ($c -eq $Quote) {
            $n = 0
            while ((Get-WowgetTomlChar $P $n) -eq $Quote) { $n++ }
            if ($n -ge 3) {
                if ($n -gt 5) { throw (New-WowgetTomlError $P 'too many quotes at the end of a multi-line string') }
                [void]$sb.Append($Quote, $n - 3)
                $P.Pos += $n
                return $sb.ToString()
            }
            [void]$sb.Append($Quote, $n)
            $P.Pos += $n
            continue
        }
        if ($Basic -and $c -eq '\') {
            # A backslash followed by whitespace up to the end of the line trims the newline and the
            # whitespace and newlines after it.
            $k = 1
            while ((Get-WowgetTomlChar $P $k) -eq ' ' -or (Get-WowgetTomlChar $P $k) -eq "`t") { $k++ }
            $next = Get-WowgetTomlChar $P $k
            if ($next -eq "`n" -or ($next -eq "`r" -and (Get-WowgetTomlChar $P ($k + 1)) -eq "`n")) {
                $P.Pos += $k
                while ($true) {
                    Skip-WowgetTomlSpace $P
                    if (-not (Read-WowgetTomlNewline $P)) { break }
                }
                continue
            }
            Read-WowgetTomlEscape $P $sb
            continue
        }
        if ($c -eq "`r") {
            if ((Get-WowgetTomlChar $P 1) -ne "`n") { throw (New-WowgetTomlError $P 'carriage return without a newline') }
            [void]$sb.Append("`r`n")
            $P.Pos += 2
            continue
        }
        if ($c -ne "`n" -and (Test-WowgetTomlControl $c)) { throw (New-WowgetTomlError $P 'control character in a string') }
        [void]$sb.Append($c)
        $P.Pos++
    }
}

function ConvertFrom-WowgetTomlNumber {
    param([Parameter(Mandatory)]$P, [Parameter(Mandatory)][string]$Token, [int]$At)
    $inv = [System.Globalization.CultureInfo]::InvariantCulture
    if ($Token -cmatch '^\d{4}-\d{2}-\d{2}' -or $Token -cmatch '^\d{2}:\d{2}') {
        throw (New-WowgetTomlError $P 'dates and times are not supported in a wowget manifest' $At)
    }
    if ($Token -cmatch '^[+-]?(inf|nan)$') {
        if ($Matches[1] -ceq 'nan') { return [double]::NaN }
        if ($Token.StartsWith('-')) { return [double]::NegativeInfinity }
        return [double]::PositiveInfinity
    }
    $digits = $Token.Replace('_', '')
    $base = 0
    if ($Token -cmatch '^0x[0-9A-Fa-f](_?[0-9A-Fa-f])*$') { $base = 16 }
    elseif ($Token -cmatch '^0o[0-7](_?[0-7])*$') { $base = 8 }
    elseif ($Token -cmatch '^0b[01](_?[01])*$') { $base = 2 }
    if ($base) {
        try { $value = [Convert]::ToInt64($digits.Substring(2), $base) } catch { $value = -1 }
        if ($value -lt 0) { throw (New-WowgetTomlError $P "integer $Token is out of range" $At) }
        return $value
    }
    if ($Token -cmatch '^[+-]?(0|[1-9](_?[0-9])*)$') {
        $value = 0L
        if (-not [long]::TryParse($digits, [System.Globalization.NumberStyles]::AllowLeadingSign, $inv, [ref]$value)) {
            throw (New-WowgetTomlError $P "integer $Token is out of range" $At)
        }
        return $value
    }
    if ($Token -cmatch '^[+-]?(0|[1-9](_?[0-9])*)(\.[0-9](_?[0-9])*)?([eE][+-]?[0-9](_?[0-9])*)?$' -and ($Token.Contains('.') -or $Token -match '[eE]')) {
        return [double]::Parse($digits, [System.Globalization.NumberStyles]::Float, $inv)
    }
    throw (New-WowgetTomlError $P "invalid value $Token" $At)
}

function Read-WowgetTomlValue {
    param([Parameter(Mandatory)]$P)
    $c = Get-WowgetTomlChar $P
    if ($c -eq '"') {
        if ((Get-WowgetTomlChar $P 1) -eq '"' -and (Get-WowgetTomlChar $P 2) -eq '"') { return Read-WowgetTomlMultilineString $P '"' $true }
        return Read-WowgetTomlBasicString $P
    }
    if ($c -eq "'") {
        if ((Get-WowgetTomlChar $P 1) -eq "'" -and (Get-WowgetTomlChar $P 2) -eq "'") { return Read-WowgetTomlMultilineString $P "'" $false }
        return Read-WowgetTomlLiteralString $P
    }
    if ($c -eq '[') { return , (Read-WowgetTomlArray $P) }
    if ($c -eq '{') { return , (Read-WowgetTomlInlineTable $P) }
    $start = $P.Pos
    while (-not (Test-WowgetTomlEnd $P)) {
        $ch = $P.Text[$P.Pos]
        if ((Test-WowgetTomlBareKeyChar $ch) -or $ch -eq '+' -or $ch -eq '.' -or $ch -eq ':') { $P.Pos++ } else { break }
    }
    $token = $P.Text.Substring($start, $P.Pos - $start)
    if ($token -ceq 'true') { return $true }
    if ($token -ceq 'false') { return $false }
    if ($token -eq '') { throw (New-WowgetTomlError $P "expected a value, found '$c'") }
    return ConvertFrom-WowgetTomlNumber $P $token $start
}

function Read-WowgetTomlArray {
    param([Parameter(Mandatory)]$P)
    $list = [System.Collections.Generic.List[object]]::new()
    [void]$P.Static.Add($list)
    $P.Pos++
    while ($true) {
        Skip-WowgetTomlBlank $P
        if ((Get-WowgetTomlChar $P) -eq ']') { $P.Pos++; return , $list }
        if (Test-WowgetTomlEnd $P) { throw (New-WowgetTomlError $P 'unterminated array') }
        $list.Add((Read-WowgetTomlValue $P))
        Skip-WowgetTomlBlank $P
        $c = Get-WowgetTomlChar $P
        if ($c -eq ',') { $P.Pos++; continue }
        if ($c -eq ']') { $P.Pos++; return , $list }
        throw (New-WowgetTomlError $P "expected ',' or ']' in an array")
    }
}

function Read-WowgetTomlInlineTable {
    param([Parameter(Mandatory)]$P)
    $table = New-WowgetTomlTable
    $P.Kinds[$table] = 'inline'
    $P.Pos++
    Skip-WowgetTomlSpace $P
    if ((Get-WowgetTomlChar $P) -eq '}') { $P.Pos++; return , $table }
    while ($true) {
        Skip-WowgetTomlSpace $P
        Read-WowgetTomlKeyValue $P $table -Inline
        Skip-WowgetTomlSpace $P
        $c = Get-WowgetTomlChar $P
        if ($c -eq ',') { $P.Pos++; continue }
        if ($c -eq '}') { $P.Pos++; return , $table }
        throw (New-WowgetTomlError $P "expected ',' or '}' in an inline table")
    }
}

# Reads "key = value" into $Table. Dotted keys create tables that only dotted keys may extend.
function Read-WowgetTomlKeyValue {
    param([Parameter(Mandatory)]$P, [Parameter(Mandatory)]$Table, [switch]$Inline)
    $at = $P.Pos
    $parts = Read-WowgetTomlKey $P
    Skip-WowgetTomlSpace $P
    if ((Get-WowgetTomlChar $P) -ne '=') { throw (New-WowgetTomlError $P "expected '=' after the key") }
    $P.Pos++
    Skip-WowgetTomlSpace $P
    $value = Read-WowgetTomlValue $P
    $current = $Table
    for ($k = 0; $k -lt $parts.Count - 1; $k++) {
        $name = $parts[$k]
        if (-not $current.Contains($name)) {
            $child = New-WowgetTomlTable
            $P.Kinds[$child] = $(if ($Inline) { 'idotted' } else { 'dotted' })
            $current[$name] = $child
            $current = $child
            continue
        }
        $existing = $current[$name]
        $kind = if ($existing -is [System.Collections.IDictionary]) { $P.Kinds[$existing] } else { $null }
        # Dotted keys extend only tables that dotted keys of the same table created; inline tables are
        # closed once written.
        $allowed = if ($Inline) { 'idotted' } else { 'dotted' }
        if ($kind -ne $allowed) {
            throw (New-WowgetTomlError $P "key $($parts[0..$k] -join '.') is already defined" $at)
        }
        $current = $existing
    }
    $last = $parts[-1]
    if ($current.Contains($last)) { throw (New-WowgetTomlError $P "key $($parts -join '.') is already defined" $at) }
    $current[$last] = $value
}

function Get-WowgetTomlKind {
    param([Parameter(Mandatory)]$P, $Value)
    if ($Value -is [System.Collections.IDictionary]) { return $P.Kinds[$Value] }
    if ($Value -is [System.Collections.IList]) { if ($P.Static.Contains($Value)) { return 'array' } return 'aot' }
    return 'value'
}

# Reads a [table] or [[array of tables]] header and returns the table that keys go into.
function Read-WowgetTomlHeader {
    param([Parameter(Mandatory)]$P, [Parameter(Mandatory)]$Root)
    $at = $P.Pos
    $array = (Get-WowgetTomlChar $P 1) -eq '['
    $P.Pos += $(if ($array) { 2 } else { 1 })
    Skip-WowgetTomlSpace $P
    $parts = Read-WowgetTomlKey $P
    Skip-WowgetTomlSpace $P
    if ($array) {
        if ((Get-WowgetTomlChar $P) -ne ']' -or (Get-WowgetTomlChar $P 1) -ne ']') { throw (New-WowgetTomlError $P "expected ']]'") }
        $P.Pos += 2
    } else {
        if ((Get-WowgetTomlChar $P) -ne ']') { throw (New-WowgetTomlError $P "expected ']'") }
        $P.Pos++
    }
    $label = $parts -join '.'
    $current = $Root
    for ($k = 0; $k -lt $parts.Count - 1; $k++) {
        $name = $parts[$k]
        if (-not $current.Contains($name)) {
            $child = New-WowgetTomlTable
            $P.Kinds[$child] = 'implicit'
            $current[$name] = $child
            $current = $child
            continue
        }
        $existing = $current[$name]
        $kind = Get-WowgetTomlKind $P $existing
        if ($kind -eq 'aot') { $current = $existing[$existing.Count - 1]; continue }
        if ($kind -in 'implicit', 'header', 'dotted') { $current = $existing; continue }
        throw (New-WowgetTomlError $P "cannot define table [$label]: $($parts[0..$k] -join '.') is already defined" $at)
    }
    $last = $parts[-1]
    if ($array) {
        $table = New-WowgetTomlTable
        $P.Kinds[$table] = 'header'
        if (-not $current.Contains($last)) {
            $list = [System.Collections.Generic.List[object]]::new()
            $current[$last] = $list
        } elseif ((Get-WowgetTomlKind $P $current[$last]) -eq 'aot') {
            $list = $current[$last]
        } else {
            throw (New-WowgetTomlError $P "cannot define array of tables [[$label]]: $label is already defined" $at)
        }
        $list.Add($table)
        return , $table
    }
    if (-not $current.Contains($last)) {
        $table = New-WowgetTomlTable
        $P.Kinds[$table] = 'header'
        $current[$last] = $table
        return , $table
    }
    $existing = $current[$last]
    if ((Get-WowgetTomlKind $P $existing) -eq 'implicit') {
        $P.Kinds[$existing] = 'header'
        return , $existing
    }
    throw (New-WowgetTomlError $P "table [$label] is already defined" $at)
}

# Parses TOML text. $File prefixes error messages.
function ConvertFrom-WowgetToml {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text, [string]$File = '')
    $refs = [System.Collections.Generic.ReferenceEqualityComparer]::Instance
    $p = [pscustomobject]@{
        Text   = $Text.TrimStart([char]0xFEFF)
        Pos    = 0
        Prefix = $(if ($File) { "${File}: " } else { '' })
        Kinds  = [System.Collections.Generic.Dictionary[object, string]]::new($refs)
        Static = [System.Collections.Generic.HashSet[object]]::new($refs)
    }
    $root = New-WowgetTomlTable
    $p.Kinds[$root] = 'header'
    $table = $root
    while ($true) {
        Skip-WowgetTomlSpace $p
        if (Test-WowgetTomlEnd $p) { break }
        $c = $p.Text[$p.Pos]
        if ($c -eq '#') { Assert-WowgetTomlLineEnd $p; continue }
        if (Read-WowgetTomlNewline $p) { continue }
        if ($c -eq '[') { $table = Read-WowgetTomlHeader $p $root }
        else { Read-WowgetTomlKeyValue $p $table }
        Assert-WowgetTomlLineEnd $p
    }
    return , $root
}

# The JSON manifest a TOML manifest holds. The TOML layout ([targets.<name>] and [[addon]]) is mapped
# to the JSON one, which then goes through the usual manifest validation.
function ConvertFrom-WowgetTomlManifest {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text, [Parameter(Mandatory)][string]$File)
    $data = ConvertFrom-WowgetToml $Text $File
    if ($data.Contains('install')) {
        throw (New-WowgetError 'manifest' "${File}: this manifest uses the [install] table of an old wowget version. Move it aside and run `"wowget init`" to create a new one.")
    }
    foreach ($key in $data.Keys) {
        if ($key -cnotin 'targets', 'addon') { throw (New-WowgetError 'manifest' "${File}: unknown key `"$key`" in the top level") }
    }
    $doc = [ordered]@{ version = 1 }
    if ($data.Contains('targets')) { $doc['targets'] = $data['targets'] }
    if ($data.Contains('addon')) { $doc['addons'] = $data['addon'] }
    return ConvertFrom-WowgetManifestText (ConvertTo-WowgetJsonText $doc) $File
}

# Converts the TOML manifest at $TomlPath when the JSON manifest it maps to does not exist yet.
# Symlinks are resolved first, so the JSON file is written next to the real TOML file; a symlink to it
# is created next to a TOML symlink where the platform allows. Returns ManifestPath (the JSON manifest
# to use from now on), Converted (whether a file was written) and Notes for the user.
function Convert-WowgetTomlManifestFile {
    param(
        [Parameter(Mandatory)][string]$TomlPath,
        [string]$Platform = (Get-WowgetPlatform),
        # Whether --manifest or WOWGET_MANIFEST named the TOML file.
        [switch]$Named
    )
    $notes = [System.Collections.Generic.List[string]]::new()
    $full = [System.IO.Path]::GetFullPath($TomlPath)
    $real = Resolve-WowgetWriteTarget $full
    $isLink = $real -ne $full
    $jsonName = [System.IO.Path]::GetFileNameWithoutExtension($real) + '.json'
    $jsonPath = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($real), $jsonName)
    $converted = $false
    if (Test-WowgetPath $jsonPath) {
        $notes.Add("$TomlPath was already converted to $jsonPath; using that.")
    } else {
        $manifest = ConvertFrom-WowgetTomlManifest (Read-WowgetText $real) $real
        [void](Write-WowgetManifestChecked $jsonPath $null $manifest)
        $converted = $true
        $notes.Add("Converted $real to $jsonPath. Comments were not carried over; check the new file, then the old one can be deleted.")
    }
    $use = $jsonPath
    if ($isLink) {
        $linkJson = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($full), [System.IO.Path]::GetFileNameWithoutExtension($full) + '.json')
        if (Test-WowgetPath $linkJson) {
            $use = $linkJson
        } elseif ($Platform -ne 'Windows') {
            [void][System.IO.File]::CreateSymbolicLink($linkJson, $jsonPath)
            $notes.Add("Created the symlink $linkJson -> $jsonPath.")
            $use = $linkJson
        } else {
            $notes.Add("Set WOWGET_MANIFEST to $jsonPath; creating a symlink next to $full needs Developer Mode or administrator rights.")
        }
    }
    if ($Named) { $notes.Add("Point --manifest or WOWGET_MANIFEST at $use from now on.") }
    return [pscustomobject]@{ From = $real; ManifestPath = $use; JsonPath = $jsonPath; Converted = $converted; Notes = $notes.ToArray() }
}
