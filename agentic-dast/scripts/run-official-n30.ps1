<#
.SYNOPSIS
  Runner da rodada oficial (n=30 por cenario) do experimento comparativo
  do TCC Agentic DAST.

.DESCRIPTION
  Executa cada um dos 4 cenarios (A, B, C, D) N vezes em modo round-robin
  (intercalado A B C D A B C D...) para diluir efeito de horario e rate
  limit. Antes de cada run, reinicia os containers 'juice-shop' e 'zap'
  para garantir estado limpo (evita: bloqueio de IP acumulado pela app,
  degradacao do ZAP apos scans anteriores).

  Grava progresso em CSV incremental (reports/_run-log.csv). Se
  interrompido (Ctrl+C, rate limit, crash), basta re-executar: retoma do
  ponto exato onde parou, contando as linhas ja gravadas por cenario.

  Ao final, invoca 'npm run evaluate' para produzir as metricas
  agregadas (Precision/Recall/F1 medios + intervalos de confianca por
  bootstrap na proxima iteracao do evaluate.ts).

.PARAMETER N
  Numero de runs por cenario. Default: 30.

.PARAMETER Scenarios
  Cenarios a executar. Default: A, B, C, D.

.PARAMETER SkipEval
  Nao roda 'npm run evaluate' ao final (util para retomar rodadas
  interrompidas sem sobrescrever o summary intermediario).

.EXAMPLE
  # Rodada oficial completa (~7-15h dependendo do rate limit do D)
  .\scripts\run-official-n30.ps1

.EXAMPLE
  # So o Cenario C, 10 runs (para calibrar antes do run oficial)
  .\scripts\run-official-n30.ps1 -N 10 -Scenarios C

.NOTES
  Custo estimado (Claude Pro): cerca de US\$ 40 equivalente em quota
  para 30 runs do D. Se bater rate limit, o script pausa 5 min e tenta
  de novo — nao aborta.

  Requer PowerShell 5.1+ e Docker Desktop rodando.
#>

[CmdletBinding()]
param(
  [int]$N = 30,
  [string[]]$Scenarios = @("A","B","C","D"),
  [switch]$SkipEval
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------
# Caminhos e constantes
# ---------------------------------------------------------------
$AGENTIC_DIR = Split-Path -Parent $PSScriptRoot            # ...\agentic-dast
$REPORTS_DIR = Join-Path $AGENTIC_DIR "reports"
$LOG_CSV     = Join-Path $REPORTS_DIR "_run-log.csv"
$CSV_HEADER  = "timestamp_iso,run_index,scenario,report_file,findings,duration_s,status"

$ZAP_HEALTH_TIMEOUT_S     = 60
$RATE_LIMIT_BACKOFF_S     = 300      # 5 min entre retries de rate limit
$RATE_LIMIT_MAX_ATTEMPTS  = 3

# ---------------------------------------------------------------
# Helpers de log
# ---------------------------------------------------------------
function Write-Step { param([string]$Msg) Write-Host "`n>>> $Msg" -ForegroundColor Cyan }
function Write-Info { param([string]$Msg) Write-Host "    $Msg" -ForegroundColor DarkGray }
function Write-Warn { param([string]$Msg) Write-Host "    ! $Msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$Msg) Write-Host "    X $Msg" -ForegroundColor Red }

# ---------------------------------------------------------------
# Docker: reset + espera de saude
# ---------------------------------------------------------------
function Wait-ContainerHealthy {
  param([string]$Name, [int]$TimeoutS = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutS)
  while ((Get-Date) -lt $deadline) {
    $status = docker ps --filter "name=$Name" --format "{{.Status}}" 2>$null
    if ($null -eq $status) { Start-Sleep -Seconds 2; continue }
    if ($status -match "healthy") { return $true }
    if ($status -match "unhealthy") { throw "Container $Name reportou unhealthy: $status" }
    Start-Sleep -Seconds 2
  }
  throw "Timeout ($TimeoutS s) aguardando $Name ficar healthy"
}

function Reset-Environment {
  Write-Info "docker compose restart juice-shop zap..."
  # PS 5.1 wrapea cada linha do stderr de um exe nativo como
  # NativeCommandError, e com ErrorActionPreference=Stop isso vira
  # excecao mesmo quando o comando retorna exit code 0. O docker
  # compose imprime status de progresso no stderr por design ('
  # Container zap  Restarting'), o que reproduzivelmente disparava
  # a falha. Solucao: rebaixar temporariamente para 'Continue',
  # descartar ambos os streams, e checar o exit code manualmente.
  $prevPref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    docker compose restart juice-shop zap *>$null
    if ($LASTEXITCODE -ne 0) {
      throw "docker compose restart falhou (exit $LASTEXITCODE)"
    }
  } finally {
    $ErrorActionPreference = $prevPref
  }
  # [void] descarta o valor de retorno booleano da funcao, que caso
  # contrario vazaria para o pipeline e imprimiria 'True' no console.
  [void](Wait-ContainerHealthy -Name "zap" -TimeoutS $ZAP_HEALTH_TIMEOUT_S)
  # juice-shop nao tem healthcheck no docker-compose.yml — o Docker
  # nunca marca 'healthy'. Depois de 10s de tentativa, aceita como
  # up e segue (nossa integracao real com o juice-shop testa ele
  # dentro do proprio cenario).
  try { [void](Wait-ContainerHealthy -Name "juice-shop" -TimeoutS 10) } catch { Start-Sleep -Seconds 5 }
}

# ---------------------------------------------------------------
# Descoberta do report gerado por um cenario
# ---------------------------------------------------------------
function Get-NewestReportFile {
  param([string]$Scenario, [DateTime]$Since)
  $pattern = switch ($Scenario) {
    "A" { "scenario-a-*.json" }
    "B" { "scenario-b-*.json" }
    "C" { "report-*.json" }
    "D" { "scenario-d-*.json" }
    default { throw "Cenario desconhecido: $Scenario" }
  }
  $found = Get-ChildItem -Path $REPORTS_DIR -Filter $pattern -File `
    | Where-Object { $_.LastWriteTime -ge $Since } `
    | Sort-Object LastWriteTime -Descending
  if (-not $found) { return $null }
  # Forca array pra evitar desembrulho de item unico em PS 5.1
  $arr = @($found)
  return $arr[0].Name
}

function Get-FindingsCount {
  param([string]$ReportFileName)
  if (-not $ReportFileName) { return -1 }
  $full = Join-Path $REPORTS_DIR $ReportFileName
  try {
    $json = Get-Content -Raw -Path $full | ConvertFrom-Json
    if ($null -ne $json.findingsCount) { return [int]$json.findingsCount }
    if ($null -ne $json.findings)      { return [int]($json.findings).Count }
    return -1
  } catch {
    return -1
  }
}

# ---------------------------------------------------------------
# Execucao de um scenario com retry de rate limit
# ---------------------------------------------------------------
function Invoke-Scenario {
  param([string]$Scenario)
  $target = "scenario:" + $Scenario.ToLower()
  $attempt = 0
  while ($true) {
    $attempt++
    Write-Info "npm run $target (tentativa $attempt)..."
    $start  = Get-Date

    # captura stdout+stderr para inspecionar erros de rate limit sem
    # perder visibilidade em tempo real
    $tmp = New-TemporaryFile
    try {
      & npm.cmd run $target 2>&1 | Tee-Object -FilePath $tmp.FullName
      $exit = $LASTEXITCODE
    } finally {
      $output = if (Test-Path $tmp.FullName) { Get-Content -Raw $tmp.FullName } else { "" }
      Remove-Item -Force $tmp.FullName -ErrorAction SilentlyContinue
    }

    $duration = ((Get-Date) - $start).TotalSeconds
    $rateLimited = ($output -match "rate.?limit|429|quota exceeded|too many requests|AgentAuthError")

    if ($exit -eq 0 -and -not $rateLimited) {
      return @{ Duration = $duration; Since = $start }
    }

    if ($rateLimited -and $attempt -lt $RATE_LIMIT_MAX_ATTEMPTS) {
      Write-Warn "Rate limit detectado (exit=$exit). Aguardando $RATE_LIMIT_BACKOFF_S s antes do retry $($attempt+1)/$RATE_LIMIT_MAX_ATTEMPTS..."
      Start-Sleep -Seconds $RATE_LIMIT_BACKOFF_S
      continue
    }

    # Falha nao-recuperavel — grava como 'failed' e segue pro proximo run
    Write-Err "Cenario $Scenario falhou (exit=$exit) apos $attempt tentativa(s)."
    return @{ Duration = $duration; Since = $start; Failed = $true }
  }
}

# ---------------------------------------------------------------
# CSV: header, load, append
# ---------------------------------------------------------------
function Ensure-Csv {
  if (-not (Test-Path $LOG_CSV)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LOG_CSV) | Out-Null
    Set-Content -Path $LOG_CSV -Value $CSV_HEADER -Encoding utf8
    Write-Info "CSV criado: $LOG_CSV"
  }
}

function Count-CompletedByScenario {
  $counts = @{}
  foreach ($s in $Scenarios) { $counts[$s] = 0 }
  if (Test-Path $LOG_CSV) {
    Import-Csv $LOG_CSV | Where-Object { $_.status -eq "ok" } | ForEach-Object {
      if ($counts.ContainsKey($_.scenario)) { $counts[$_.scenario]++ }
    }
  }
  return $counts
}

function Append-Row {
  param(
    [int]$RunIndex, [string]$Scenario, [string]$ReportFile,
    [int]$Findings, [double]$DurationS, [string]$Status
  )
  $iso = (Get-Date).ToUniversalTime().ToString("o")
  $reportCell = if ($ReportFile) { $ReportFile } else { "" }
  $row = @($iso, $RunIndex, $Scenario, $reportCell, $Findings,
           $DurationS.ToString("F1", [Globalization.CultureInfo]::InvariantCulture),
           $Status) -join ","
  Add-Content -Path $LOG_CSV -Value $row -Encoding utf8
}

# ---------------------------------------------------------------
# Plano round-robin com retomada
# ---------------------------------------------------------------
function Build-Plan {
  param([hashtable]$Completed)
  $plan = New-Object System.Collections.ArrayList
  for ($i = 1; $i -le $N; $i++) {
    foreach ($s in $Scenarios) {
      if ($Completed[$s] -lt $i) {
        [void]$plan.Add([pscustomobject]@{ RunIndex = $i; Scenario = $s })
      }
    }
  }
  # Devolve como array 'gordo' (,) para o PS 5.1 nao desembrulhar
  # quando ha 1 elemento, o que quebraria .Count e o loop de indice.
  return ,@($plan.ToArray())
}

# ---------------------------------------------------------------
# Main
# ---------------------------------------------------------------
Push-Location $AGENTIC_DIR
try {
  Write-Step "AGENTIC DAST - Rodada oficial (N=$N, cenarios=$($Scenarios -join ','))"

  Ensure-Csv
  $completed = Count-CompletedByScenario
  Write-Info "Runs ja completados por cenario: $(($completed.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' ')"

  $plan = Build-Plan -Completed $completed
  if ($plan.Count -eq 0) {
    Write-Info "Nada a fazer — todos os $N runs de cada cenario ja estao no CSV."
    if (-not $SkipEval) {
      Write-Step "Rodando npm run evaluate final..."
      & npm.cmd run evaluate
    }
    return
  }

  $planTotal = $plan.Count
  Write-Info "Runs pendentes: $planTotal"
  $totalStart = Get-Date

  for ($idx = 0; $idx -lt $planTotal; $idx++) {
    $step = $plan[$idx]
    $i = $step.RunIndex
    $s = $step.Scenario
    Write-Step "[$($idx+1)/$planTotal] Cenario $s - run $i/$N"

    # 1. Reset de containers para estado limpo
    try {
      Reset-Environment
    } catch {
      Write-Warn "Reset falhou: $($_.Exception.Message). Tentando novamente em 10s..."
      Start-Sleep -Seconds 10
      Reset-Environment
    }

    # 2. Executa o cenario (com retry em rate limit)
    $result = Invoke-Scenario -Scenario $s

    # 3. Descobre o report gerado e conta findings
    $reportFile = Get-NewestReportFile -Scenario $s -Since $result.Since
    $findings   = Get-FindingsCount -ReportFileName $reportFile
    $status     = if ($result.Failed) { "failed" } else { "ok" }

    # 4. Grava no CSV
    Append-Row -RunIndex $i -Scenario $s -ReportFile $reportFile `
               -Findings $findings -DurationS $result.Duration -Status $status

    $displayReport = if ($reportFile) { $reportFile } else { "sem report" }
    Write-Info "-> $displayReport | findings=$findings | duracao=$([Math]::Round($result.Duration,1))s | status=$status"
  }

  $totalMin = [Math]::Round(((Get-Date) - $totalStart).TotalMinutes, 1)
  Write-Step "Rodada concluida em $totalMin min. CSV: $LOG_CSV"

  if (-not $SkipEval) {
    Write-Step "Rodando npm run evaluate agregado..."
    & npm.cmd run evaluate
  }

} finally {
  Pop-Location
}
