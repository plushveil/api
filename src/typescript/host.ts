/**
 * Owns the TypeScript compiler session.
 *
 * TypeScript 7 has no classic compiler API — the package's main export is its version string — so
 * this uses `typescript/unstable/sync`, which talks to an out-of-process `tsgo` server. One `API`,
 * one snapshot, and one checker per CLI run; the server is torn down on the way out, including on
 * a signal, or the process would not exit.
 */

import { resolve } from 'node:path'
import { API, DiagnosticCategory, type Checker, type Program, type Symbol as TsSymbol } from 'typescript/unstable/sync'

export interface HostOptions {
  /**
   * Tsconfig to resolve types against.
   */
  project?: string
}

export interface Host {
  readonly program: Program
  readonly checker: Checker
  /**
   * Exported symbols of a module, by name.
   */
  exportsOf: (file: string) => Map<string, TsSymbol>
  /**
   * Error-category diagnostics for one file.
   */
  errorsIn: (file: string) => string[]
  close: () => void
}

/**
 * Raised when the compiler session cannot be established.
 */
export class HostError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostError'
  }
}

/**
 * Opens the project snapshot, tearing the compiler server down on failure — otherwise the tsgo
 * child would keep the event loop alive and the CLI would hang instead of reporting the error.
 */
function openSnapshot(api: API, project: string, close: () => void): ReturnType<API['updateSnapshot']> {
  try {
    return api.updateSnapshot({ openProjects: [project] })
  } catch (cause) {
    close()
    throw new HostError(`Could not open ${project}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

export function createHost(options: HostOptions = {}): Host {
  const project = resolve(options.project ?? 'tsconfig.json')
  const api = new API()

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    api.close()
  }

  // Without this the tsgo child keeps the event loop alive and the CLI hangs after printing.
  const onSignal = (): void => {
    close()
    process.exit(130)
  }
  process.once('exit', close)
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  const snapshot = openSnapshot(api, project, close)

  const opened = snapshot.getProject(project) ?? snapshot.getProjects()[0]
  if (!opened) {
    close()
    throw new HostError(`No TypeScript project was opened for ${project}`)
  }

  const { program, checker } = opened

  return {
    program,
    checker,

    exportsOf(file) {
      const source = program.getSourceFile(resolve(file))
      if (!source) throw new HostError(`${file} is not part of the project described by ${project}`)
      const moduleSymbol = checker.getSymbolAtLocation(source)
      if (!moduleSymbol) return new Map()
      return new Map(checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.name, symbol]))
    },

    errorsIn(file) {
      const absolute = resolve(file)
      // `getSemanticDiagnostics` takes a document identifier, which may be a plain path.
      return program
        .getSemanticDiagnostics(absolute)
        .filter((d) => d.category === DiagnosticCategory.Error)
        .map((d) => `${d.fileName ?? absolute}:${d.pos} ${d.text}`)
    },

    close,
  }
}
