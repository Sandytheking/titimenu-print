// Un PowerShell VIVO por impresora, en vez de uno nuevo por ticket.
//
// ## Por qué
// Medido en Windows con una 2Connect POS80 por USB: el envío costaba **~845 ms por
// ticket**, y casi todo era arrancar `powershell.exe` y compilar en caliente, con
// `Add-Type`, las llamadas a `winspool.drv`. El contenido del ticket se arma en 3 ms.
//
// Cachear el DLL compilado no bastaba: seguiría pagando el arranque del intérprete, que
// se midió aparte en la etapa «cola» —otro PowerShell— y daba ~500 ms él solo.
//
// Así que el proceso se queda vivo: compila UNA vez y luego recibe trabajos por stdin.
// Un ticket pasa a ser escribir una línea y esperar la respuesta.
//
// ## Lo que NO se hizo, y por qué
// Un módulo nativo de `winspool` para Electron sería aún más rápido (microsegundos) y sin
// proceso hijo. Se descartó por el coste de mantenimiento: hay que compilarlo contra el
// ABI de cada versión de Electron, publicar prebuilds en el workflow de Windows, y una
// subida de Electron lo rompe en silencio justo en el camino del dinero. Con el host
// persistente el coste baja a decenas de milisegundos sin añadir cadena de compilación.
//
// ## Reglas duras
// - **Un host por IMPRESORA.** Si una se cuelga, no arrastra a las otras — es lo mismo que
//   persiguen las colas de `colas.js`, un nivel más abajo.
// - **Arranque perezoso**: nada se lanza hasta el primer ticket.
// - **Tope por trabajo**: si no contesta, se mata y se reinicia en el siguiente.
// - **Si algo falla, el llamador cae al camino de siempre** para ESE ticket. Un ticket que
//   no sale es peor que un ticket lento.
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')

/** Tope por trabajo. Un ticket normal tarda decenas de ms; esto es sólo el techo. */
const TOPE_TRABAJO_MS = 8000

/** El script que corre dentro del host: compila una vez y luego sirve trabajos. */
const HOST_PS1 = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.IO;
using System.Runtime.InteropServices;

public class RawPrinter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public struct DOCINFOA {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }
    [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
    public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
    [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFOA di);
    [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]
    public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);

    public static bool SendBytesToPrinter(string printerName, byte[] bytes) {
        IntPtr hPrinter;
        DOCINFOA di = new DOCINFOA();
        di.pDocName = "TitiMenu Receipt";
        di.pDataType = "RAW";
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) return false;
        bool ok = false;
        if (StartDocPrinter(hPrinter, 1, ref di)) {
            if (StartPagePrinter(hPrinter)) {
                int written;
                ok = WritePrinter(hPrinter, bytes, bytes.Length, out written);
                EndPagePrinter(hPrinter);
            }
            EndDocPrinter(hPrinter);
        }
        ClosePrinter(hPrinter);
        return ok;
    }
}
"@

[Console]::Out.WriteLine("LISTO")
[Console]::Out.Flush()

while ($true) {
  $linea = [Console]::In.ReadLine()
  if ($null -eq $linea) { break }
  if ($linea.Trim() -eq '') { continue }
  $id = '?'
  try {
    $t = $linea | ConvertFrom-Json
    $id = $t.id
    $bytes = [System.IO.File]::ReadAllBytes($t.file)
    $ok = [RawPrinter]::SendBytesToPrinter($t.printer, $bytes)
    if ($ok) { [Console]::Out.WriteLine("OK $id") }
    else { [Console]::Out.WriteLine("ERR $id WritePrinter devolvio false") }
  } catch {
    $m = $_.Exception.Message -replace "\`r|\`n", ' '
    [Console]::Out.WriteLine("ERR $id $m")
  }
  [Console]::Out.Flush()
}
`

/** Una línea de respuesta del host: `OK <id>` o `ERR <id> <mensaje>`. */
function parsearRespuesta(linea) {
  const m = /^(OK|ERR) (\S+)(?: (.*))?$/.exec(String(linea).trim())
  if (!m) return null
  return { ok: m[1] === 'OK', id: m[2], error: m[3] }
}

/** Un host vivo por impresora. */
const hosts = new Map()
let siguienteId = 1

function matarHost(clave, motivo) {
  const h = hosts.get(clave)
  if (!h) return
  hosts.delete(clave)
  for (const [, p] of h.pendientes) {
    clearTimeout(p.timer)
    p.reject(new Error(motivo))
  }
  h.pendientes.clear()
  try { h.proc.kill() } catch {}
  try { fs.unlinkSync(h.script) } catch {}
}

function arrancarHost(clave) {
  const script = path.join(os.tmpdir(), `titimenu_host_${process.pid}_${Date.now()}.ps1`)
  fs.writeFileSync(script, HOST_PS1)

  const proc = spawn('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { stdio: ['pipe', 'pipe', 'pipe'] })

  const h = { proc, script, pendientes: new Map(), listo: false, stderr: '' }
  hosts.set(clave, h)

  const rl = readline.createInterface({ input: proc.stdout })
  rl.on('line', (linea) => {
    const t = linea.trim()
    if (t === 'LISTO') { h.listo = true; return }
    const r = parsearRespuesta(t)
    if (!r) return
    const p = h.pendientes.get(r.id)
    if (!p) return
    h.pendientes.delete(r.id)
    clearTimeout(p.timer)
    if (r.ok) p.resolve()
    else p.reject(new Error(r.error || 'fallo del host de impresión'))
  })

  proc.stderr.on('data', d => { h.stderr = (h.stderr + d.toString()).slice(-500) })
  proc.on('exit', (code) => matarHost(clave, `el host de impresión murió (código ${code}) ${h.stderr}`))
  proc.on('error', (err) => matarHost(clave, `no se pudo lanzar el host de impresión: ${err.message}`))
  return h
}

/**
 * Manda un trabajo por el host persistente.
 *
 * Rechaza si el host no está, muere o no contesta a tiempo — y entonces el llamador debe
 * caer al camino de siempre para ese ticket.
 */
function enviarPorHost(buffer, printerName, topeMs = TOPE_TRABAJO_MS) {
  if (process.platform !== 'win32') return Promise.reject(new Error('sólo Windows'))

  const clave = String(printerName)
  const h = hosts.get(clave) || arrancarHost(clave)
  if (!h.proc || h.proc.killed) return Promise.reject(new Error('host no disponible'))

  const id = String(siguienteId++)
  const archivo = path.join(os.tmpdir(), `titimenu_${id}_${Date.now()}.bin`)

  return new Promise((resolve, reject) => {
    try { fs.writeFileSync(archivo, buffer) } catch (e) { return reject(e) }

    const limpiar = () => { try { fs.unlinkSync(archivo) } catch {} }
    const timer = setTimeout(() => {
      h.pendientes.delete(id)
      limpiar()
      // No contestó: puede estar colgado. Se mata para que el siguiente ticket arranque
      // uno limpio, en vez de encolarse detrás de un proceso muerto en vida.
      matarHost(clave, 'el host de impresión no respondió a tiempo')
      reject(new Error(`el host de impresión no respondió en ${topeMs} ms`))
    }, topeMs)

    h.pendientes.set(id, {
      resolve: () => { limpiar(); resolve() },
      reject: (e) => { limpiar(); reject(e) },
      timer,
    })

    try {
      h.proc.stdin.write(JSON.stringify({ id, printer: clave, file: archivo }) + '\n')
    } catch (e) {
      clearTimeout(timer)
      h.pendientes.delete(id)
      limpiar()
      reject(e)
    }
  })
}

/** Cierra todos los hosts. Para el apagado de la app. */
function cerrarHosts() {
  for (const clave of [...hosts.keys()]) matarHost(clave, 'cierre de la aplicación')
}

module.exports = { enviarPorHost, cerrarHosts, parsearRespuesta, HOST_PS1, TOPE_TRABAJO_MS }
